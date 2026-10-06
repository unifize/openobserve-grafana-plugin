import {
  DataFrame,
  DataQueryResponse,
  LogRowContextOptions,
  LogRowContextQueryDirection,
  LogRowModel,
} from '@grafana/data';
import { isEqual } from 'lodash';
import { MyQuery } from '../../types';
import { ContextIdentity, contextSql, parseContextScope } from './contextQuery';
import { getLogsDataFrame } from './queryResponseBuilder';

export const CONTEXT_WINDOW_MICROS = 60_000_000;
export const CONTEXT_NOTE =
  'All matching logs from 60 seconds before through 60 seconds after the selected log, including outside the Explore range. ' +
  'Context matches the selected row’s deployment_environment and service_name, plus kubernetes_pod_name when available. ' +
  'Original SQL filters are ignored. No row cap is applied. ' +
  'Neighbors show body only; the highlighted line keeps its original Explore display. ' +
  'Select Oldest first in Explore for earlier logs above and later logs below. ' +
  'Timestamps retain microsecond precision; equal-time order is unspecified and repeated occurrences are retained. ' +
  'If a wrapped matched line covers the view, unpin it or use the jump buttons.';

type LogRecord = Record<string, unknown>;
type Search = (target: MyQuery, request: unknown) => Promise<{ hits?: LogRecord[]; is_partial?: boolean }>;

/** Immutable provenance of this result, never the datasource's most recent query. */
export interface LogContextSource {
  target: MyQuery;
  sql: string;
  startTime: number;
  endTime: number;
  timestampColumn: string;
  streamFields: MyQuery['streamFields'];
}

interface ContextWindow {
  before: LogRecord[];
  after: LogRecord[];
  selected: LogRecord;
}

export class ContextSession {
  result?: Promise<ContextWindow>;
  error?: string;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setError(message?: string) {
    this.error = message;
    this.listeners.forEach((listener) => listener());
  }
}

// Weak ownership by originating result frame, independent across queries and Explore panes.
const sessions = new WeakMap<LogContextSource, Map<string, ContextSession>>();

export function contextSource(row: LogRowModel): LogContextSource {
  const source = row.dataFrame.meta?.custom?.openobserveContext as LogContextSource | undefined;
  if (!source) {
    throw new Error('Show context requires query provenance. Rerun the original Explore query first.');
  }
  return source;
}

export function contextSession(row: LogRowModel): ContextSession {
  const source = contextSource(row);
  let byRow = sessions.get(source);
  if (!byRow) {
    byRow = new Map();
    sessions.set(source, byRow);
  }
  const key = `${row.rowIndex}:${row.raw}`;
  let session = byRow.get(key);
  if (!session) {
    session = new ContextSession();
    byRow.set(key, session);
  }
  return session;
}

function selectedRecord(
  row: LogRowModel,
  source: LogContextSource
): { record: LogRecord; timestamp: number; identity: ContextIdentity } {
  // Content retains the complete original API record, including microseconds.
  // Use the frame value, not the rounded timeEpochMs or rendered/unescaped entry.
  let record: LogRecord;
  try {
    record = JSON.parse(row.dataFrame.fields[row.entryFieldIndex].values[row.rowIndex]) as LogRecord;
  } catch {
    throw new Error('The original log record is unavailable. Rerun the Explore query to retrieve context.');
  }
  const raw = record?.[source.timestampColumn];
  const timestamp = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    throw new Error('Show context requires an exact, safe-integer microsecond timestamp in the original log record.');
  }
  if (timestamp < source.startTime || timestamp >= source.endTime) {
    throw new Error('The selected log is outside the original Explore search range. Rerun the query.');
  }
  const environment = record.deployment_environment;
  const service = record.service_name;
  if (typeof environment !== 'string' || !environment.trim() || typeof service !== 'string' || !service.trim()) {
    throw new Error(
      'Show context requires non-empty deployment_environment and service_name fields on the selected log. ' +
        'Context was not fetched because searching without both would mix unrelated environments or services.'
    );
  }
  const pod = record.kubernetes_pod_name;
  return {
    record,
    timestamp,
    identity: {
      deployment_environment: environment,
      service_name: service,
      ...(typeof pod === 'string' && pod.trim() ? { kubernetes_pod_name: pod } : {}),
    },
  };
}

export function contextProblem(row: LogRowModel): string | undefined {
  try {
    const source = contextSource(row);
    parseContextScope(source.sql);
    selectedRecord(row, source);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'This query cannot safely retrieve log context.';
  }
}

export function contextUsesPod(row: LogRowModel): boolean {
  return selectedRecord(row, contextSource(row)).identity.kubernetes_pod_name !== undefined;
}

function projectContextRecord(record: LogRecord, timestampColumn: string, includePod: boolean): LogRecord {
  const raw = record[timestampColumn];
  const timestamp = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    throw new Error('Context requires exact, safe-integer microsecond timestamps. No rounded timestamps were used.');
  }
  if (record.body != null && typeof record.body !== 'string') {
    throw new Error('Show context requires the body field to contain text or null.');
  }
  return {
    [timestampColumn]: timestamp,
    body: record.body ?? null,
    deployment_environment: record.deployment_environment,
    service_name: record.service_name,
    ...(includePod ? { kubernetes_pod_name: record.kubernetes_pod_name } : {}),
  };
}

/** No total row cap. Re-fetching avoids OFFSET/cursor gaps across timestamp ties.
 * OpenObserve size:-1 is NOT unlimited: it silently applies its default limit
 * (with is_partial). Explicit positive sizes bypass that default on v1.0.4.
 * Use only the final complete response, never merge changing result prefixes.
 */
async function fetchAll(
  target: MyQuery,
  query: { sql: string; sql_mode: string; start_time: number; end_time: number },
  search: Search
): Promise<LogRecord[]> {
  for (let size = 1000; ; size *= 2) {
    const response = await search(target, { query: { ...query, size } });
    if (response.is_partial) {
      throw new Error('OpenObserve returned partial context. The complete 120-second window could not be loaded. Retry the request.');
    }
    if (response.hits !== undefined && !Array.isArray(response.hits)) {
      throw new Error('OpenObserve returned an invalid context response.');
    }
    const hits = response.hits ?? [];
    if (hits.length < size) {
      return hits;
    }
  }
}

async function fetchWindow(row: LogRowModel, source: LogContextSource, search: Search): Promise<ContextWindow> {
  const scope = parseContextScope(source.sql);
  const { record, timestamp, identity } = selectedRecord(row, source);
  const includePod = identity.kubernetes_pod_name !== undefined;
  const selected = projectContextRecord(record, source.timestampColumn, includePod);
  const startTime = timestamp - CONTEXT_WINDOW_MICROS;
  // OpenObserve's end is exclusive. Include the exact +60-second microsecond.
  const endTime = timestamp + CONTEXT_WINDOW_MICROS + 1;
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime)) {
    throw new Error('The context window exceeds safe-integer microsecond precision.');
  }
  const hits = await fetchAll(source.target, {
    sql: contextSql(scope, identity, source.timestampColumn),
    sql_mode: 'full',
    start_time: startTime,
    end_time: endTime,
  }, search);
  const records = hits.map((hit) => {
    const projected = projectContextRecord(hit, source.timestampColumn, includePod);
    const time = projected[source.timestampColumn] as number;
    if (
      projected.deployment_environment !== identity.deployment_environment ||
      projected.service_name !== identity.service_name ||
      (includePod && projected.kubernetes_pod_name !== identity.kubernetes_pod_name) ||
      time < startTime ||
      time >= endTime
    ) {
      throw new Error('OpenObserve returned context outside the selected environment, service, pod, or time window.');
    }
    return projected;
  });
  records.sort((a, b) => (a[source.timestampColumn] as number) - (b[source.timestampColumn] as number));
  const selectedIndex = records.findIndex((hit) => isEqual(hit, selected));
  if (selectedIndex === -1) {
    throw new Error('The selected log was not found in the context response. Rerun the Explore query and retry.');
  }
  const before: LogRecord[] = [];
  const after: LogRecord[] = [];
  records.forEach((hit, index) => {
    // Remove exactly one occurrence; never collapse identical physical records.
    if (index !== selectedIndex) {
      ((hit[source.timestampColumn] as number) <= timestamp ? before : after).push(hit);
    }
  });
  return { before, after, selected };
}

function failureMessage(error: unknown): string {
  const response = error as { data?: { message?: string; error_detail?: string }; statusText?: string } | null;
  return (
    response?.data?.error_detail ||
    response?.data?.message ||
    (error instanceof Error ? error.message : response?.statusText) ||
    'OpenObserve context request failed. Please retry the query.'
  );
}

function contextFrame(
  records: LogRecord[],
  window: ContextWindow,
  source: LogContextSource,
  direction: LogRowContextQueryDirection
): DataFrame {
  const metadataFields = Object.keys(window.selected)
    .filter((name) => name !== 'body')
    .map((name) => ({ name, type: name === source.timestampColumn ? 'Int64' : 'Utf8' }));
  const frame = getLogsDataFrame(
    records,
    { ...source.target, refId: `${source.target.refId}-context-${direction}` },
    metadataFields,
    source.timestampColumn
  );
  // Context-only formatting: never mutate the original Explore frame or selected row.
  const bodyField = frame.fields[1];
  bodyField.name = 'body';
  let occurrence = 1;
  bodyField.values = records.map((record) => {
    const body = record.body ?? '';
    // Preserve separate occurrences of the selected projected tuple even if
    // Grafana compares rendered text + time instead of distinct row IDs.
    return isEqual(record, window.selected)
      ? `${body} [context occurrence ${++occurrence}; no stable record ID]`
      : body;
  });
  frame.meta = { ...frame.meta, custom: { openobserveContext: source, openobserveContextPage: true } };
  return frame;
}

export async function getLogContext(
  row: LogRowModel,
  options: LogRowContextOptions,
  search: Search
): Promise<DataQueryResponse> {
  // The full fixed window is already loaded. Native boundary auto-paging must
  // not move the anchor or fetch records beyond its +/-60-second bounds.
  if (row.dataFrame.meta?.custom?.openobserveContextPage) {
    return { data: [] };
  }
  const source = contextSource(row);
  const session = contextSession(row);
  if (!session.result) {
    session.setError();
    session.result = fetchWindow(row, source, search).catch((error) => {
      const message = failureMessage(error);
      session.result = undefined; // Closing/reopening the viewer can retry a failed request.
      session.setError(message);
      throw new Error(message);
    });
  }
  const window = await session.result;
  const direction = options.direction ?? LogRowContextQueryDirection.Backward;
  const records = direction === LogRowContextQueryDirection.Backward ? window.before : window.after;
  return { data: records.length ? [contextFrame(records, window, source, direction)] : [] };
}

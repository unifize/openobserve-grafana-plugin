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

export const CONTEXT_LIMIT = 100;
export const CONTEXT_NOTE =
  `V1: at most ${CONTEXT_LIMIT} earlier and ${CONTEXT_LIMIT} later records within the original Explore range. ` +
  'Context matches only the selected row’s deployment_environment and service_name, across pods. Original SQL filters are ignored. ' +
  'Neighbors show body only; the highlighted line keeps its original Explore display. ' +
  'Equal-time order is unspecified; projection-identical peers retain separate occurrences. ' +
  '“No more logs available” can mean the V1 cap. If a wrapped matched line covers the view, unpin it or use the jump buttons.';

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
  return { record, timestamp, identity: { deployment_environment: environment, service_name: service } };
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

function projectContextRecord(record: LogRecord, timestampColumn: string): LogRecord {
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
  };
}

async function fetchWindow(row: LogRowModel, source: LogContextSource, search: Search): Promise<ContextWindow> {
  const scope = parseContextScope(source.sql);
  const { record, timestamp, identity } = selectedRecord(row, source);
  const selected = projectContextRecord(record, source.timestampColumn);
  const fetch = async (comparison: '<' | '>' | '=', limit: number) => {
    const response = await search(source.target, {
      query: {
        sql: contextSql(scope, identity, source.timestampColumn, timestamp, comparison, limit),
        sql_mode: 'full',
        start_time: source.startTime,
        end_time: source.endTime,
        size: limit,
      },
    });
    if (response.is_partial) {
      throw new Error('OpenObserve returned partial context. Narrow the original time range and retry.');
    }
    if (response.hits !== undefined && !Array.isArray(response.hits)) {
      throw new Error('OpenObserve returned an invalid context response.');
    }
    return (response.hits ?? []).map((hit) => {
      const projected = projectContextRecord(hit, source.timestampColumn);
      const time = projected[source.timestampColumn] as number;
      if (
        projected.deployment_environment !== identity.deployment_environment ||
        projected.service_name !== identity.service_name ||
        time < source.startTime ||
        time >= source.endTime
      ) {
        throw new Error('OpenObserve returned context outside the selected environment, service, or time range.');
      }
      return projected;
    });
  };
  // Strict sides plus a separate equality bucket avoid skipping same-microsecond records.
  // One lookahead detects an overflowing tie bucket instead of silently truncating it.
  const [earlier, later, equal] = await Promise.all([
    fetch('<', CONTEXT_LIMIT),
    fetch('>', CONTEXT_LIMIT),
    fetch('=', CONTEXT_LIMIT + 2),
  ]);
  if (equal.length > CONTEXT_LIMIT + 1) {
    throw new Error(
      `More than ${CONTEXT_LIMIT} peers share this timestamp. V1 cannot select a complete tie group without a stable record ID. Choose another log timestamp; changing SQL filters cannot reduce this context group.`
    );
  }
  const selectedIndex = equal.findIndex((hit) => isEqual(hit, selected));
  if (selectedIndex === -1) {
    throw new Error('The selected log was not found in the context response. Rerun the Explore query and retry.');
  }
  // Projection hides other metadata: identical tuples are interchangeable, not
  // deduplicated. Remove exactly one occurrence for the native highlighted row.
  const peers = equal.filter((_, index) => index !== selectedIndex);
  if (peers.length > CONTEXT_LIMIT) {
    throw new Error('The equal-timestamp group exceeds the V1 context limit; no records were silently discarded.');
  }
  return {
    before: [...earlier.slice(0, CONTEXT_LIMIT - peers.length).reverse(), ...peers],
    after: later,
    selected,
  };
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
  const metadataFields = [...new Set([source.timestampColumn, 'deployment_environment', 'service_name'])]
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
  // Grafana auto-pages from boundary rows. Do not issue a new moving window:
  // the notice explicitly distinguishes this V1 cap from exhaustion of the stream.
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

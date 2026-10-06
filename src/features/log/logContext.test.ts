import { Field, LogRowContextQueryDirection, LogRowModel } from '@grafana/data';
import { MyQuery } from '../../types';
import { contextProblem, contextUsesPod, getLogContext, LogContextSource } from './logContext';
import { getLogsDataFrame } from './queryResponseBuilder';

const timestamp = 1_790_000_000_123456;
const anchor = {
  _timestamp: timestamp,
  body: 'anchor',
  deployment_environment: 'production',
  service_name: 'checkout',
  kubernetes_pod_name: 'checkout-a',
};
const target: MyQuery = {
  refId: 'A', query: '', constant: 1, sqlMode: true, organization: 'default', stream: 'default', streamFields: [],
};
const backward = { direction: LogRowContextQueryDirection.Backward };
const forward = { direction: LogRowContextQueryDirection.Forward };

function row(record: Record<string, unknown> = anchor): LogRowModel {
  const source: LogContextSource = {
    target,
    sql: `SELECT * FROM "default" WHERE severity = 'ERROR' AND body LIKE '%anchor%' ORDER BY _timestamp DESC LIMIT 1`,
    startTime: timestamp - 10,
    endTime: timestamp + 10,
    timestampColumn: '_timestamp',
    streamFields: [],
  };
  const frame = getLogsDataFrame([record], target);
  frame.meta = { ...frame.meta, custom: { openobserveContext: source } };
  return { dataFrame: frame, rowIndex: 0, entryFieldIndex: 1, raw: JSON.stringify(record) } as LogRowModel;
}

function hit(time: number, body = String(time)) {
  return { ...anchor, _timestamp: time, body };
}

describe('fixed-window log context', () => {
  it('loads one uncapped window, inclusive at ±60s, beyond Explore, without original filters', async () => {
    const selected = row();
    const search = jest.fn().mockResolvedValue({ hits: [hit(timestamp + 60_000_000), anchor, hit(timestamp - 60_000_000)] });
    const [before, after] = await Promise.all([
      getLogContext(selected, backward, search), getLogContext(selected, forward, search),
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    const request = search.mock.calls[0][1].query;
    expect(request).toMatchObject({ start_time: timestamp - 60_000_000, end_time: timestamp + 60_000_001, size: 1000, sql_mode: 'full' });
    expect(request.sql).toContain('"kubernetes_pod_name" = \'checkout-a\'');
    expect(request.sql).toContain('ORDER BY "_timestamp" ASC');
    expect(request.sql).not.toMatch(/severity|LIKE|LIMIT|OFFSET|DESC/);
    expect(before.data[0].length).toBe(1);
    expect(after.data[0].length).toBe(1);
    expect(selected.dataFrame.fields[1].values[0]).toBe(JSON.stringify(anchor));
  });

  it('preserves more than 201 records, large equal-time groups, and identical occurrences', async () => {
    const earlier = Array.from({ length: 250 }, (_, i) => hit(timestamp - 250 + i));
    const later = Array.from({ length: 250 }, (_, i) => hit(timestamp + 1 + i));
    const peers = Array.from({ length: 150 }, () => ({ ...anchor }));
    const search = jest.fn().mockResolvedValue({ hits: [...later.reverse(), anchor, ...peers, ...earlier.reverse()] });
    const selected = row();
    const before = (await getLogContext(selected, backward, search)).data[0];
    const after = (await getLogContext(selected, forward, search)).data[0];
    expect(before.length).toBe(400);
    expect(after.length).toBe(250);
    const timeField = before.fields.find((field: Field) => field.name === '_timestamp')!;
    expect(timeField.values).toEqual([...earlier.reverse().map((record) => record._timestamp), ...peers.map(() => timestamp)]);
    expect(before.fields[1].values.filter((body: string) => body.includes('context occurrence'))).toHaveLength(150);
    expect(after.fields[0].nanos?.slice(0, 3)).toEqual([457000, 458000, 459000]);
    expect(before.fields[0].values[0]).toBe(Math.floor((timestamp - 250) / 1000));
  });

  it('grows requests without a cap and uses only the final complete response, including ties', async () => {
    const records = [anchor, ...Array.from({ length: 2500 }, () => hit(timestamp + 1, 'identical'))];
    const search = jest.fn().mockImplementation((_target, request) => Promise.resolve({ hits: records.slice(0, request.query.size) }));
    const result = await getLogContext(row(), forward, search);
    expect(search.mock.calls.map((call) => call[1].query.size)).toEqual([1000, 2000, 4000]);
    expect(result.data[0].length).toBe(2500);
    expect(result.data[0].fields[1].values).toEqual(Array(2500).fill('identical'));
    expect(search.mock.calls.map((call) => call[1].query.sql)).toEqual(Array(3).fill(search.mock.calls[0][1].query.sql));
  });

  it('checks a full-size response with another fetch before declaring completion', async () => {
    const records = [anchor, ...Array.from({ length: 999 }, () => hit(timestamp + 1))];
    const search = jest.fn().mockResolvedValue({ hits: records });
    const result = await getLogContext(row(), forward, search);
    expect(search.mock.calls.map((call) => call[1].query.size)).toEqual([1000, 2000]);
    expect(result.data[0].length).toBe(999);
  });

  it.each([undefined, null, '', '  ', 42])('falls back to environment/service for invalid pod %p', async (pod) => {
    const record = { ...anchor, kubernetes_pod_name: pod };
    const selected = row(record);
    expect(contextUsesPod(selected)).toBe(false);
    const search = jest.fn().mockResolvedValue({ hits: [record, { ...hit(timestamp + 1), kubernetes_pod_name: 'another-pod' }] });
    const result = await getLogContext(selected, forward, search);
    expect(result.data[0].length).toBe(1);
    expect(search.mock.calls[0][1].query.sql).not.toContain('kubernetes_pod_name');
    expect(search.mock.calls[0][1].query.sql).toContain('"deployment_environment" = \'production\'');
    expect(search.mock.calls[0][1].query.sql).toContain('"service_name" = \'checkout\'');
  });

  it('retains exact pod contents and escapes quoted scope values', async () => {
    const record = { ...anchor, kubernetes_pod_name: " pod'o ", service_name: "check'out" };
    const selected = row(record);
    expect(contextUsesPod(selected)).toBe(true);
    const search = jest.fn().mockResolvedValue({ hits: [record] });
    await getLogContext(selected, backward, search);
    expect(search.mock.calls[0][1].query.sql).toContain('"kubernetes_pod_name" = \' pod\'\'o \'');
    expect(search.mock.calls[0][1].query.sql).toContain('"service_name" = \'check\'\'out\'');
  });

  it.each(['deployment_environment', 'service_name'])('requires %s even when pod is valid', async (field) => {
    const selected = row({ ...anchor, [field]: '' });
    const search = jest.fn();
    expect(contextProblem(selected)).toContain('requires non-empty');
    await expect(getLogContext(selected, backward, search)).rejects.toThrow('requires non-empty');
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    { kubernetes_pod_name: 'wrong-pod' },
    { deployment_environment: 'wrong-environment' },
    { service_name: 'wrong-service' },
    { _timestamp: timestamp - 60_000_001 },
    { _timestamp: timestamp + 60_000_001 },
  ])('rejects responses outside the scope/window: %p', async (changes) => {
    const search = jest.fn().mockResolvedValue({ hits: [anchor, { ...anchor, ...changes }] });
    await expect(getLogContext(row(), backward, search)).rejects.toThrow('outside the selected');
  });

  it('does not move the window when Grafana auto-pages from a context frame', async () => {
    const search = jest.fn().mockResolvedValue({ hits: [anchor, hit(timestamp - 1)] });
    const result = await getLogContext(row(), backward, search);
    const boundary = { ...row(), dataFrame: result.data[0] } as LogRowModel;
    expect(await getLogContext(boundary, backward, search)).toEqual({ data: [] });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('fails clearly on partial responses and allows retry', async () => {
    const search = jest.fn().mockResolvedValueOnce({ hits: [anchor], is_partial: true }).mockResolvedValue({ hits: [anchor] });
    const selected = row();
    await expect(getLogContext(selected, backward, search)).rejects.toThrow('partial context');
    expect(await getLogContext(selected, backward, search)).toEqual({ data: [] });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps different selected rows and source results isolated', async () => {
    const search = jest.fn().mockResolvedValue({ hits: [anchor] });
    await getLogContext(row(), backward, search);
    await getLogContext(row(), backward, search);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each([{ hits: [] }, { hits: 'invalid' }, { hits: [{ ...anchor, _timestamp: 1.1 }] }])('rejects invalid or missing selected records: %p', async (response) => {
    await expect(getLogContext(row(), backward, jest.fn().mockResolvedValue(response))).rejects.toThrow();
  });

  it('accepts exact numeric-string timestamps without rounding', async () => {
    const selected = row({ ...anchor, _timestamp: String(timestamp) });
    const search = jest.fn().mockResolvedValue({ hits: [anchor, { ...hit(timestamp + 1), _timestamp: String(timestamp + 1) }] });
    const result = await getLogContext(selected, forward, search);
    expect(result.data[0].fields[0].nanos).toEqual([457000]);
  });
});

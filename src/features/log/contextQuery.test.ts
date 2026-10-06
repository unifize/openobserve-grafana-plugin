import { contextSql, parseContextScope } from './contextQuery';

describe('context SQL', () => {
  it('extracts only the source stream from a restrictive original query', () => {
    const scope = parseContextScope(`SELECT * FROM "logs" WHERE body LIKE '%error%' AND kubernetes_pod_name = 'wrong' ORDER BY _timestamp DESC LIMIT 1 OFFSET 4`);
    const sql = contextSql(scope, { deployment_environment: 'prod', service_name: 'api', kubernetes_pod_name: 'actual' }, '_timestamp');
    expect(sql).toBe(`SELECT "_timestamp", "body", "deployment_environment", "service_name", "kubernetes_pod_name" FROM "logs" WHERE "deployment_environment" = 'prod' AND "service_name" = 'api' AND "kubernetes_pod_name" = 'actual'\nORDER BY "_timestamp" ASC`);
  });

  it('does not reference a potentially absent pod column in fallback mode', () => {
    const sql = contextSql(parseContextScope('SELECT * FROM logs'), { deployment_environment: 'prod', service_name: 'api' }, '_timestamp');
    expect(sql).not.toContain('kubernetes_pod_name');
    expect(sql).not.toMatch(/LIMIT|OFFSET/);
  });

  it('escapes identifiers and literal scope without trusting SQL filters', () => {
    const sql = contextSql(parseContextScope('SELECT * FROM "log""stream"'), { deployment_environment: "it's prod", service_name: 'api' }, 'custom"timestamp');
    expect(sql).toContain('FROM "log""stream"');
    expect(sql).toContain('"deployment_environment" = \'it\'\'s prod\'');
    expect(sql).toContain('ORDER BY "custom""timestamp" ASC');
  });

  it.each([
    'SELECT body FROM logs',
    'SELECT * FROM logs JOIN other ON logs.id = other.id',
    'SELECT * FROM (SELECT * FROM logs)',
    'SELECT * FROM logs UNION SELECT * FROM other',
    'SELECT * FROM logs; SELECT * FROM other',
    'SELECT * FROM logs GROUP BY body',
  ])('refuses ambiguous source provenance: %s', (sql) => {
    expect(() => parseContextScope(sql)).toThrow('single stream');
  });
});

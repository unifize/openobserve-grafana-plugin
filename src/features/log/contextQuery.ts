/** Only the unambiguous source stream is reused; original SQL filters are not. */
export interface ContextScope {
  from: string;
  stream: string;
}

export interface ContextIdentity {
  deployment_environment: string;
  service_name: string;
  kubernetes_pod_name?: string;
}

const UNSUPPORTED =
  'Show context V1 requires complete log rows from SELECT * FROM a single stream. ' +
  'WHERE, ORDER BY, LIMIT and OFFSET do not constrain context. ' +
  'Joins, subqueries, projections and aggregations are not supported. Context was not fetched.';

export function parseContextScope(sql: string): ContextScope {
  // Ignore literals/comments when checking provenance. Other operators are tokens
  // too, but are never copied into context SQL or used to infer row scope.
  const lexer =
    /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_][\w$]*|\d+(?:\.\d+)?|[^\s]/g;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(sql);
    if (!match || match.index !== offset) {
      throw new Error(UNSUPPORTED);
    }
    const text = match[0];
    if (!/^\s|^--|^\/\*/.test(text)) {
      tokens.push(text);
    }
    offset = lexer.lastIndex;
  }
  if (tokens[tokens.length - 1] === ';') {
    tokens.pop();
  }
  if (
    tokens[0]?.toUpperCase() !== 'SELECT' ||
    tokens[1] !== '*' ||
    tokens[2]?.toUpperCase() !== 'FROM' ||
    !/^(?:"(?:""|[^"])+"|[a-zA-Z_][\w$]*)$/.test(tokens[3] ?? '') ||
    (tokens.length > 4 && !/^(where|order|limit|offset|fetch)$/i.test(tokens[4])) ||
    tokens.length === 5
  ) {
    throw new Error(UNSUPPORTED);
  }
  let depth = 0;
  for (const text of tokens.slice(4)) {
    if (
      /^(select|from|join|union|intersect|except|group|having|qualify|window|into|with)$/i.test(text) ||
      text === ';'
    ) {
      throw new Error(UNSUPPORTED);
    }
    if (text === '(') {
      depth++;
    } else if (text === ')') {
      depth--;
    }
    if (depth < 0) {
      throw new Error(UNSUPPORTED);
    }
  }
  if (depth !== 0) {
    throw new Error(UNSUPPORTED);
  }
  return {
    from: tokens[3],
    stream: tokens[3].replace(/^"|"$/g, '').replace(/""/g, '"'),
  };
}

export function contextSql(
  scope: ContextScope,
  identity: ContextIdentity,
  timestampColumn: string
): string {
  const field = `"${timestampColumn.replace(/"/g, '""')}"`;
  // Keep exact time and scope as metadata; only body is rendered as the context line.
  const scopeFields = ['deployment_environment', 'service_name'] as Array<keyof ContextIdentity>;
  // A stream without pod metadata may not even have this column in its schema.
  if (identity.kubernetes_pod_name !== undefined) {
    scopeFields.push('kubernetes_pod_name');
  }
  const columns = [...new Set([timestampColumn, 'body', ...scopeFields])]
    .map((column) => `"${column.replace(/"/g, '""')}"`)
    .join(', ');
  // Rebuild scope exclusively from the clicked record. Never reuse SQL filters.
  const selectedScope = scopeFields
    .map((column) => `"${column}" = '${identity[column]!.replace(/'/g, "''")}'`)
    .join(' AND ');
  // API bounds supply the fixed window; the caller grows size until complete.
  return `SELECT ${columns} FROM ${scope.from} WHERE ${selectedScope}\nORDER BY ${field} ASC`;
}

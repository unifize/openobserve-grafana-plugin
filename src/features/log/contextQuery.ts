/** Only the unambiguous source stream is reused; original SQL filters are not. */
export interface ContextScope {
  from: string;
  stream: string;
}

export interface ContextIdentity {
  deployment_environment: string;
  service_name: string;
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
  timestampColumn: string,
  timestamp: number,
  comparison: '<' | '>' | '=',
  limit: number
): string {
  const field = `"${timestampColumn.replace(/"/g, '""')}"`;
  // Keep exact time and scope as metadata; only body is rendered as the context line.
  const columns = [...new Set([timestampColumn, 'body', 'deployment_environment', 'service_name'])]
    .map((column) => `"${column.replace(/"/g, '""')}"`)
    .join(', ');
  // Both values come only from the clicked record, never the query text.
  // Deliberately omit every original SQL filter, including pod/message/severity.
  // These are log values, not SQL: escape single quotes without changing their contents.
  const environment = identity.deployment_environment.replace(/'/g, "''");
  const service = identity.service_name.replace(/'/g, "''");
  const selectedScope = `"deployment_environment" = '${environment}' AND "service_name" = '${service}'`;
  return (
    `SELECT ${columns} FROM ${scope.from} WHERE ${selectedScope} AND ${field} ${comparison} ${timestamp}\n` +
    `ORDER BY ${field} ${comparison === '<' ? 'DESC' : 'ASC'} LIMIT ${limit}`
  );
}

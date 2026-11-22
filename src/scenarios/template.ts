export type TemplateContext = Record<string, unknown>;

const TOKEN = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s*\}\}/gi;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

function lookup(ctx: TemplateContext, dotted: string): unknown {
  let cur: unknown = ctx;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Plain substitution of {{a.b.c}} tokens. No expressions. An unknown token is an error. */
export function renderString(input: string, ctx: TemplateContext): string {
  return input.replace(TOKEN, (_m, key: string) => {
    const value = lookup(ctx, key);
    if (value === undefined || value === null || typeof value === 'object') {
      throw new TemplateError(`Unknown template value "{{${key}}}".`);
    }
    return String(value);
  });
}

/** Renders every string in a value. Keys are not rendered. */
export function renderDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') return renderString(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx);
    return out as T;
  }
  return value;
}

/** Lists every token in a value, for example ["params.card", "secrets.basic_auth_pass"]. */
export function collectTokens(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) if (m[1]) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectTokens(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectTokens(v, out);
  }
  return out;
}

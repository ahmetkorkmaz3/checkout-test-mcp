import type { ToolResultShape } from '../errors/tool-error.js';

/** Success result: structured content plus the same JSON as text for clients that ignore structured content. */
export function jsonResult(
  value: object,
  extra: ToolResultShape['content'] = [],
  prefix?: string,
): ToolResultShape {
  const json = JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text: prefix ? `${prefix}\n\n${json}` : json }, ...extra],
    structuredContent: value as Record<string, unknown>,
  };
}

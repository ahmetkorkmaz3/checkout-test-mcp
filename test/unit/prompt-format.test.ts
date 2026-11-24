import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_TEXT } from '../../src/prompts/setup-checkout-tests.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Every property name and every enum or const string in the generated JSON Schemas of the zod shapes. */
function schemaWords(): Set<string> {
  const words = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.properties && typeof o.properties === 'object') {
      for (const k of Object.keys(o.properties)) words.add(k);
    }
    if (o.patternProperties && typeof o.patternProperties === 'object') {
      // Keys that match a pattern, such as param names. Nothing to add.
    }
    for (const v of [o.const, ...(Array.isArray(o.enum) ? o.enum : [])]) {
      if (typeof v === 'string') words.add(v);
    }
    for (const v of Object.values(o)) walk(v);
  };
  for (const file of ['schemas/scenario.schema.json', 'schemas/fragment.schema.json']) {
    walk(JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')));
  }
  return words;
}

/** Key-like words in the code spans. Templates, placeholders, and quoted values are not keys. */
function codeTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const span = (m[1] ?? '')
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/"[^"]*"/g, ' ');
    for (const t of span.match(/[a-z][a-z_]*/g) ?? []) tokens.add(t);
  }
  return tokens;
}

// "true" is the value in "required: true".
const unknownWords = (tokens: Set<string>, words: Set<string>) =>
  [...tokens].filter((t) => !words.has(t) && t !== 'true');

describe('FORMAT_TEXT', () => {
  it('names only keys and values that exist in the scenario and fragment schemas', () => {
    const tokens = codeTokens(FORMAT_TEXT);
    const words = schemaWords();
    expect(tokens.size).toBeGreaterThan(50);
    expect(unknownWords(tokens, words)).toEqual([]);
    // The check finds a key that the schemas do not have.
    expect(unknownWords(codeTokens('`{ bogus_key, goto }`'), words)).toEqual(['bogus_key']);
    // The capture shape and the frame shape of visible and hidden are in the text.
    for (const key of ['from_response', 'json_path', 'body_regex', 'pattern', 'within', 'locator', 'name']) {
      expect(tokens.has(key), key).toBe(true);
    }
  });
});

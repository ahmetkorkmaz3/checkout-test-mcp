import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Fragment, Scenario } from '../src/schemas/scenario.js';

const targets = [
  { schema: Scenario, file: 'scenario.schema.json', title: 'checkout-test-mcp scenario' },
  { schema: Fragment, file: 'fragment.schema.json', title: 'checkout-test-mcp fragment' },
];

for (const t of targets) {
  const json = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' });
  await writeFile(
    new URL(`../schemas/${t.file}`, import.meta.url),
    `${JSON.stringify({ title: t.title, ...json }, null, 2)}\n`,
  );
  process.stdout.write(`schemas/${t.file} written\n`);
}

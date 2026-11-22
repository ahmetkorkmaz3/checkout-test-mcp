import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Scenario } from '../src/schemas/scenario.js';

const schema = z.toJSONSchema(Scenario, { io: 'input', unrepresentable: 'any' });
await writeFile(
  new URL('../schemas/scenario.schema.json', import.meta.url),
  `${JSON.stringify({ title: 'checkout-test-mcp scenario', ...schema }, null, 2)}\n`,
);
process.stdout.write('schemas/scenario.schema.json written\n');

// Starts the built server over stdio and calls list_scenarios. Usage: npx tsx scripts/smoke-stdio.ts [config]
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const config = process.argv[2] ?? 'checkout-test-mcp.config.yaml';
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--config', config],
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const res = await client.callTool({ name: 'list_scenarios', arguments: {} });
const out = res.structuredContent as { targets: { name: string }[]; scenarios: { id: string }[] };
process.stdout.write(
  `tools: ${tools.map((t) => t.name).join(', ')}\ntargets: ${out.targets.map((t) => t.name).join(', ')}\nscenarios: ${out.scenarios.map((s) => s.id).join(', ')}\n`,
);
await client.close();

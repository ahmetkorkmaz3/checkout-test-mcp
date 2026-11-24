import { McpServer } from '@modelcontextprotocol/server';
import type { InspectionManager } from './inspect/manager.js';
import type { Logger } from './logger.js';
import type { RunManager } from './runs/manager.js';
import type { ScenarioRegistry } from './scenarios/registry.js';
import type { ResolvedConfig } from './schemas/config.js';
import { registerCompareRuns } from './tools/compare-runs.js';
import { registerGetRunResult } from './tools/get-run-result.js';
import { registerInspectTarget } from './tools/inspect-target.js';
import { registerListScenarios } from './tools/list-scenarios.js';
import { registerRunScenario } from './tools/run-scenario.js';
import { registerSaveScenario } from './tools/save-scenario.js';
import { VERSION } from './version.js';

export interface ServerDeps {
  config: ResolvedConfig;
  registry: ScenarioRegistry;
  manager: RunManager;
  inspections: InspectionManager;
  logger: Logger;
}

/** Transport-agnostic server. index.ts connects it to stdio. An HTTP transport can reuse it. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'checkout-test-mcp', version: VERSION },
    {
      instructions: [
        'Runs end-to-end checkout and payment test scenarios against configured test environments only.',
        'Order of calls: list_scenarios, then run_scenario (with an idempotency_key), then get_run_result with wait_s 20 until status is "finished". Use compare_runs for before/after checks.',
        'A failed checkout is a normal result with verdict "failed", not a tool error.',
        'To add a scenario, write the YAML and call save_scenario with validate_on, then get_run_result.',
        'To set up tests for a new target, call inspect_target first and read its suggested_scenarios.',
      ].join(' '),
    },
  );
  registerListScenarios(server, deps);
  registerRunScenario(server, deps);
  registerGetRunResult(server, deps);
  registerCompareRuns(server, deps);
  registerSaveScenario(server, deps);
  registerInspectTarget(server, deps);
  return server;
}

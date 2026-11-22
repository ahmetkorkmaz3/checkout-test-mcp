import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toToolErrorResult } from '../errors/tool-error.js';
import { NextAction, ParamValue, RunId, RunStatus } from '../schemas/common.js';
import { RunOptions } from '../schemas/run.js';
import type { ServerDeps } from '../server.js';
import { jsonResult } from './result.js';

export const RunScenarioInput = z.object({
  target: z.string().min(1).describe('Target name from list_scenarios.targets, for example "my-staging".'),
  scenario_id: z
    .string()
    .min(1)
    .describe('Scenario id from list_scenarios.scenarios, for example "card-3ds-challenge-fail".'),
  params: z
    .record(z.string(), ParamValue)
    .default({})
    .describe('Scenario params by name. Omit a param to use its default.'),
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/)
    .describe('8 to 128 characters: letters, digits, ".", "_", ":", "-". Same key = same run.'),
  options: RunOptions.default({ timeout_multiplier: 1, capture: 'failure_only', trace: false }),
});

export const RunScenarioOutput = z.object({
  run_id: RunId,
  status: RunStatus,
  reused_existing_run: z
    .boolean()
    .describe('True when this idempotency_key already had a run. No new checkout started.'),
  scenario_id: z.string(),
  target: z.string(),
  resolved_params: z.record(z.string(), ParamValue),
  estimated_duration_s: z.number().int(),
  next: NextAction.describe('Normally: call get_run_result with wait_s 20.'),
});

export const RUN_SCENARIO_DESCRIPTION = [
  'Starts one checkout test scenario against a configured test environment and returns a run_id at once. The run continues in the background, usually for 30 to 180 seconds.',
  'Then call get_run_result with the run_id to get progress and the final verdict. Do not call run_scenario again to check progress.',
  'idempotency_key is required: use the same key when you retry this call after a timeout or transport error, and the server returns the first run instead of starting a second checkout. Use a new key only when you want a new run, for example "pr-4812-3ds-fail-after-deploy".',
  'target and scenario_id must come from list_scenarios. Only test environments from the server config are accepted, never URLs. Card params take test card ids, never card numbers.',
].join(' ');

export function registerRunScenario(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'run_scenario',
    {
      title: 'Start a checkout test run',
      description: RUN_SCENARIO_DESCRIPTION,
      inputSchema: RunScenarioInput,
      outputSchema: RunScenarioOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { record, reused } = await deps.manager.start({
          target: args.target,
          scenario_id: args.scenario_id,
          params: args.params,
          idempotency_key: args.idempotency_key,
          options: args.options,
        });
        const scenario = deps.registry.get(record.scenario_id)?.scenario;
        return jsonResult({
          run_id: record.run_id,
          status: record.status,
          reused_existing_run: reused,
          scenario_id: record.scenario_id,
          target: record.target,
          resolved_params: record.params,
          estimated_duration_s: 10 + (scenario?.steps.length ?? 0) * 4,
          next: {
            kind: 'call_tool',
            description: reused
              ? 'This key already had a run. Get its result.'
              : 'Wait for the run and get the result.',
            tool: 'get_run_result',
            arguments: { run_id: record.run_id, wait_s: 20 },
          },
        });
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}

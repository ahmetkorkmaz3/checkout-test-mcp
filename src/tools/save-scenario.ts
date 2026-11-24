import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { saveScenario } from '../authoring/save.js';
import { toToolErrorResult } from '../errors/tool-error.js';
import { NextAction, ParamValue, RunId, RunStatus } from '../schemas/common.js';
import type { ServerDeps } from '../server.js';
import { jsonResult } from './result.js';

const Kind = z.enum(['scenario', 'fragment', 'test_data']);

export const SaveScenarioInput = z.object({
  kind: Kind.describe(
    '"scenario" for a runnable scenario, "fragment" for reusable steps (kind: fragment), "test_data" for a data file such as customers/guest.yaml.',
  ),
  path: z
    .string()
    .min(1)
    .describe(
      'Relative path with lowercase letters, digits, and hyphens, ending in ".yaml", for example "guest/card-success.yaml". Scenarios and fragments are relative to the authoring folder. Test data is relative to the test data folder. No "..", no absolute path.',
    ),
  yaml: z.string().min(1).max(65_536).describe('The full file text. Max 65536 characters.'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Set to true to replace a file that exists with different content.'),
  validate_on: z
    .object({
      target: z.string().min(1).describe('Target name from list_scenarios.targets. Never a URL.'),
      params: z
        .record(z.string(), ParamValue)
        .optional()
        .describe('Scenario params for the validation run. Omit a param to use its default.'),
    })
    .optional()
    .describe('Only for kind "scenario". Starts a run of the saved scenario on this target.'),
});

const Issue = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string().describe('YAML path, for example "steps.3.click".'),
  message: z.string(),
  fix: z.string(),
});

export const SaveScenarioOutput = z.object({
  path: z.string().describe('The relative path of the file.'),
  kind: Kind,
  scenario_id: z.string().nullable().describe('The scenario id. null for a fragment or test data.'),
  written: z.boolean().describe('True when the server wrote the file in this call.'),
  unchanged: z
    .boolean()
    .describe('True when the file already had this content. A retry after a lost response is safe.'),
  fixes_applied: z.array(z.string()).describe('Changes that the server made to the text before the write.'),
  warnings: z.array(Issue).describe('Rule issues that did not stop the save. Fix them in a later save.'),
  validation: z
    .object({
      run_id: RunId,
      status: RunStatus,
      reused_existing_run: z
        .boolean()
        .describe('True when the same file, fragments, target, and params already had a validation run.'),
    })
    .nullable()
    .describe('The validation run. null without validate_on.'),
  next: NextAction,
});

export const SAVE_SCENARIO_DESCRIPTION = [
  'Writes one scenario, fragment, or test data YAML file that you wrote, after the server checks it. The path is relative to the authoring folder of the server config (test data: the test data folder).',
  'The server adds the schema line and schema_version, validates the schema, and loads all scenario folders with the new file as a trial. It refuses literal emails, phones, and passwords, and weak outcome checks. A rule failure is SCENARIO_INVALID with every issue in details.issues. Other refusals: REAL_CARD_DATA_REFUSED (a card number), SECRET_IN_ARGUMENTS (a secret), PATH_REFUSED, SCENARIO_EXISTS, AUTHORING_DISABLED. A refusal writes nothing.',
  'Saving the same content again is safe and returns unchanged: true. To change a file, set overwrite: true.',
  'validate_on starts a run of the saved scenario on a test target. Then call get_run_result with the run_id. The same file, fragments, target, and params give the same run.',
].join(' ');

export function registerSaveScenario(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'save_scenario',
    {
      title: 'Save a scenario file',
      description: SAVE_SCENARIO_DESCRIPTION,
      inputSchema: SaveScenarioInput,
      outputSchema: SaveScenarioOutput,
      // validate_on starts a browser run against a test target, so the tool reaches outside the server.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await saveScenario(deps, args));
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}

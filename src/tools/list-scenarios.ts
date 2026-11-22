import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toToolErrorResult } from '../errors/tool-error.js';
import { TEST_CARDS } from '../safety/test-cards.js';
import { CardBehaviour, ExpectedOutcome, ParamValue } from '../schemas/common.js';
import type { ServerDeps } from '../server.js';
import { jsonResult } from './result.js';

export const ListScenariosInput = z.object({
  target: z.string().optional().describe('Only show scenarios that can run on this target. Omit to see all.'),
  tag: z.string().optional().describe('Only show scenarios with this tag, for example "3ds" or "negative".'),
  scenario_id: z.string().optional().describe('Only show this one scenario, with full param details.'),
});

export const ListScenariosOutput = z.object({
  targets: z.array(
    z.object({ name: z.string(), description: z.string(), profile: z.string(), base_url: z.string() }),
  ),
  scenarios: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      tags: z.array(z.string()),
      expected_outcome: ExpectedOutcome,
      compatible_targets: z.array(z.string()),
      estimated_duration_s: z.number().int(),
      params: z.array(
        z.object({
          name: z.string(),
          type: z.enum(['string', 'integer', 'number', 'boolean', 'enum', 'test_card']),
          required: z.boolean(),
          default: ParamValue.optional(),
          description: z.string(),
          values: z.array(z.string()).optional(),
          minimum: z.number().optional(),
          maximum: z.number().optional(),
          test_card_behaviour: z.string().optional(),
        }),
      ),
    }),
  ),
  test_cards: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      brand: z.string(),
      last4: z.string(),
      behaviour: CardBehaviour,
      description: z.string(),
    }),
  ),
});
type Output = z.infer<typeof ListScenariosOutput>;

export const LIST_SCENARIOS_DESCRIPTION = [
  'Lists the checkout and payment test scenarios this server can run, the targets (test environments) they can run against, and the test cards you can use.',
  'Call this first, before run_scenario, to get valid values for scenario_id, target, and params.',
  'Each scenario lists its params with type, default, and description. Params of type "test_card" take an id from the test_cards list, never a card number.',
  'This tool is read-only and fast.',
].join(' ');

export function registerListScenarios(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_scenarios',
    {
      title: 'List checkout test scenarios',
      description: LIST_SCENARIOS_DESCRIPTION,
      inputSchema: ListScenariosInput,
      outputSchema: ListScenariosOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const targets = Object.entries(deps.config.targets);
        const targetFilter = args.target ? deps.config.targets[args.target] : undefined;
        const scenarios = deps.registry
          .list()
          .map((l) => l.scenario)
          .filter((s) => !args.scenario_id || s.id === args.scenario_id)
          .filter((s) => !args.tag || s.tags.includes(args.tag))
          .filter(
            (s) => !args.target || (targetFilter && s.compatible_profiles.includes(targetFilter.profile)),
          );

        const out: Output = {
          targets: targets.map(([name, t]) => ({
            name,
            description: t.description,
            profile: t.profile,
            base_url: t.base_url,
          })),
          scenarios: scenarios.map((s) => ({
            id: s.id,
            title: s.title,
            summary: s.summary,
            tags: s.tags,
            expected_outcome: s.expected_outcome,
            compatible_targets: targets
              .filter(([, t]) => s.compatible_profiles.includes(t.profile))
              .map(([n]) => n),
            estimated_duration_s: 10 + s.steps.length * 4,
            params: Object.entries(s.params).map(([name, p]) => ({
              name,
              type: p.type,
              required: p.required === true && p.default === undefined,
              ...(p.default !== undefined ? { default: p.default } : {}),
              description: p.description,
              ...(p.type === 'enum' ? { values: p.values } : {}),
              ...((p.type === 'integer' || p.type === 'number') && p.minimum !== undefined
                ? { minimum: p.minimum }
                : {}),
              ...((p.type === 'integer' || p.type === 'number') && p.maximum !== undefined
                ? { maximum: p.maximum }
                : {}),
              ...(p.type === 'test_card' && p.constraints?.behaviour
                ? { test_card_behaviour: p.constraints.behaviour }
                : {}),
            })),
          })),
          test_cards: TEST_CARDS.map((c) => ({
            id: c.id,
            provider: c.provider,
            brand: c.brand,
            last4: c.number.slice(-4),
            behaviour: c.behaviour,
            description: c.description,
          })),
        };
        return jsonResult(out);
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}

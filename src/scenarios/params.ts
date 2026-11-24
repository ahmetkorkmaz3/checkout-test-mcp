import { ToolError } from '../errors/tool-error.js';
import { getTestCard, TEST_CARDS, type TestCard } from '../safety/test-cards.js';
import type { ParamValue } from '../schemas/common.js';
import type { Scenario } from '../schemas/scenario.js';

/** A card that a run can use: a registered test card or a live card of a production target. */
export type RunCard = Pick<
  TestCard,
  'id' | 'provider' | 'brand' | 'number' | 'expiry' | 'cvc' | 'behaviour' | 'description'
>;

export const LIVE_CARD_PREFIX = 'live/';

export interface ResolvedParams {
  values: Record<string, ParamValue>;
  cards: Record<string, RunCard>;
}

function invalid(scenarioId: string, message: string, param: string, hint: string): ToolError {
  return new ToolError({
    code: 'INVALID_PARAMS',
    message,
    likelyCause: hint,
    nextActions: [
      {
        kind: 'call_tool',
        description: `Read the param list of "${scenarioId}" and call run_scenario again with a valid "${param}".`,
        tool: 'list_scenarios',
        arguments: { scenario_id: scenarioId },
      },
    ],
    details: { param },
  });
}

/**
 * Checks the params against the scenario and resolves test card ids.
 * liveCards holds the live cards of a production target, keyed by full id ("live/<name>").
 * Leave it out for a test target. A live card id then fails.
 */
export function resolveParams(
  scenario: Scenario,
  input: Record<string, ParamValue>,
  liveCards?: Record<string, RunCard>,
): ResolvedParams {
  const values: Record<string, ParamValue> = {};
  const cards: Record<string, RunCard> = {};
  const id = scenario.id;

  for (const name of Object.keys(input)) {
    if (!(name in scenario.params)) {
      const known = Object.keys(scenario.params);
      throw invalid(
        id,
        `Scenario "${id}" has no param "${name}".`,
        name,
        `Known params: ${known.length ? known.join(', ') : 'none'}.`,
      );
    }
  }

  for (const [name, def] of Object.entries(scenario.params)) {
    const raw = input[name] ?? def.default;
    if (raw === undefined) {
      throw invalid(id, `Param "${name}" is required.`, name, `"${name}": ${def.description}`);
    }
    switch (def.type) {
      case 'string':
        if (typeof raw !== 'string')
          throw invalid(id, `Param "${name}" must be a string.`, name, def.description);
        values[name] = raw;
        break;
      case 'integer':
      case 'number': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n !== 'number' || Number.isNaN(n) || (def.type === 'integer' && !Number.isInteger(n))) {
          throw invalid(
            id,
            `Param "${name}" must be a${def.type === 'integer' ? 'n integer' : ' number'}.`,
            name,
            def.description,
          );
        }
        if (
          (def.minimum !== undefined && n < def.minimum) ||
          (def.maximum !== undefined && n > def.maximum)
        ) {
          throw invalid(
            id,
            `Param "${name}" must be between ${def.minimum ?? '-inf'} and ${def.maximum ?? 'inf'}. Got ${n}.`,
            name,
            def.description,
          );
        }
        values[name] = n;
        break;
      }
      case 'boolean':
        if (typeof raw !== 'boolean')
          throw invalid(id, `Param "${name}" must be true or false.`, name, def.description);
        values[name] = raw;
        break;
      case 'enum':
        if (typeof raw !== 'string' || !def.values.includes(raw)) {
          throw invalid(
            id,
            `Param "${name}" must be one of: ${def.values.join(', ')}.`,
            name,
            def.description,
          );
        }
        values[name] = raw;
        break;
      case 'test_card': {
        const wanted = def.constraints?.behaviour;
        const valid = [...TEST_CARDS, ...Object.values(liveCards ?? {})]
          .filter((c) => !wanted || c.behaviour === wanted)
          .map((c) => c.id);
        const isLive = typeof raw === 'string' && raw.startsWith(LIVE_CARD_PREFIX);
        if (isLive && !liveCards) {
          throw invalid(
            id,
            `Param "${name}": live card "${raw}" is not available. Live cards need a production target.`,
            name,
            `This target is a test target. Valid ids for this param: ${valid.join(', ')}.`,
          );
        }
        const card: RunCard | undefined =
          typeof raw !== 'string' ? undefined : isLive ? liveCards?.[raw] : getTestCard(raw);
        if (isLive && !card) {
          throw invalid(
            id,
            `Param "${name}": live card "${String(raw)}" is not in the live_cards of this target.`,
            name,
            `Valid ids for this param: ${valid.join(', ')}.`,
          );
        }
        if (!card) {
          throw invalid(
            id,
            `Param "${name}" must be a test card id. "${String(raw)}" is not one.`,
            name,
            `Valid ids for this param: ${valid.join(', ')}.`,
          );
        }
        if (wanted && card.behaviour !== wanted) {
          throw invalid(
            id,
            `${isLive ? 'Live' : 'Test'} card "${card.id}" has behaviour "${card.behaviour}". This scenario needs "${wanted}".`,
            name,
            `Valid ids for this param: ${valid.join(', ')}.`,
          );
        }
        values[name] = card.id;
        cards[name] = card;
        break;
      }
    }
  }
  return { values, cards };
}

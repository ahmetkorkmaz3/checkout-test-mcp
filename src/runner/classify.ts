import type { FailureCategory, NextAction } from '../schemas/common.js';

export interface ClassifyInput {
  category: FailureCategory;
  scenarioId: string;
  target: string;
  stepId: string;
  urlBefore: string | undefined;
  urlAfter: string | undefined;
  serverErrorsInStep: string[];
  blockedInStep: string[];
  hint: string | undefined;
  timeoutMultiplier: number;
  isOutcomeCheck: boolean;
  message?: string;
}

export interface Classified {
  category: FailureCategory;
  likely_causes: string[];
  next_actions: NextAction[];
}

function rerun(input: ClassifyInput, description: string, extra: Record<string, unknown> = {}): NextAction {
  return {
    kind: 'change_argument',
    description,
    tool: 'run_scenario',
    arguments: { target: input.target, scenario_id: input.scenarioId, ...extra },
  };
}

const REPORT_REGRESSION: NextAction = {
  kind: 'treat_as_regression',
  description:
    'Report the failing step with the screenshot, the expected and actual values, and the relevant network failures.',
};

const FIX_SCENARIO: NextAction = {
  kind: 'fix_scenario',
  description:
    'Open the screenshot, compare the page with the step locator, and update the scenario YAML if the UI changed on purpose.',
};

/** Rule-based hypotheses. The order of likely_causes is the order of likelihood. */
export function classify(input: ClassifyInput): Classified {
  const causes: string[] = [];
  const actions: NextAction[] = [];
  let category = input.category;

  if (input.blockedInStep.length > 0 && category !== 'blocked_by_safety') {
    causes.push(
      `The host guard blocked requests to ${input.blockedInStep.slice(0, 3).join(', ')}. A required host can be missing from the target's allowed_hosts or third_party_hosts.`,
    );
    actions.push({
      kind: 'ask_human',
      description:
        'Ask a human to check the blocked hosts and add a host to the target config if it is a test host.',
    });
  }

  if (input.serverErrorsInStep.length > 0 && (category === 'element_not_found' || category === 'timeout')) {
    category = 'unexpected_response';
  }

  switch (category) {
    case 'element_not_found': {
      const urlChanged =
        input.urlBefore !== undefined && input.urlAfter !== undefined && input.urlBefore !== input.urlAfter;
      if (urlChanged) {
        causes.push(
          `The page moved to ${input.urlAfter}, which the scenario did not expect here. The checkout flow can be different now.`,
        );
        actions.push(REPORT_REGRESSION, FIX_SCENARIO);
      } else {
        causes.push(
          'The locator does not match the current page. The UI text, role, or test id can be different now.',
        );
        causes.push('The element did not appear because the page did not finish an earlier action.');
        actions.push(FIX_SCENARIO, REPORT_REGRESSION);
      }
      break;
    }
    case 'assertion_failed':
      causes.push(
        input.isOutcomeCheck
          ? 'The checkout reached a different end state than the scenario expects. This is a probable regression.'
          : 'The element exists but shows a different value or state than the scenario expects.',
      );
      actions.push(REPORT_REGRESSION, FIX_SCENARIO);
      break;
    case 'unexpected_response':
      if (input.serverErrorsInStep.length > 0) {
        causes.push(`The backend returned an error: ${input.serverErrorsInStep.slice(0, 3).join(', ')}.`);
      } else {
        causes.push('An API call did not happen or returned another status than the scenario expects.');
      }
      actions.push(REPORT_REGRESSION);
      break;
    case 'timeout':
      causes.push('The environment is slow, or a page waits for a resource that never loads.');
      if (input.timeoutMultiplier < 5) {
        actions.push(
          rerun(input, 'Run the scenario again with a longer timeout and a new idempotency_key.', {
            options: { timeout_multiplier: Math.min(5, input.timeoutMultiplier * 2) },
          }),
        );
      }
      actions.push(REPORT_REGRESSION);
      break;
    case 'navigation_failed':
      causes.push('The page did not load. The server returned an error or the connection broke.');
      actions.push({
        kind: 'wait_and_retry',
        description: 'Wait and run the scenario again with a new idempotency_key.',
        after_s: 60,
      });
      actions.push(REPORT_REGRESSION);
      break;
    case 'target_unreachable':
      causes.push(
        'The test environment is down, the host name does not resolve, or a VPN connection is needed.',
      );
      actions.push({
        kind: 'ask_human',
        description: 'Ask a human to check that the test environment is up and reachable from this machine.',
      });
      actions.push({
        kind: 'wait_and_retry',
        description: 'Run the scenario again later with a new idempotency_key.',
        after_s: 120,
      });
      break;
    case 'blocked_by_safety':
      causes.push(
        'A safety rule stopped the run: a request to a host outside the allowlist, or a card number outside the test card registry.',
      );
      actions.push({
        kind: 'ask_human',
        description:
          'Ask a human to check the blocked request or value. Do not try to work around the safety rule.',
      });
      break;
    case 'browser_error':
      if (input.message?.startsWith('No browser found.')) {
        causes.push('No browser is available on the machine that runs the MCP server.');
        // The text comes from launchBrowser. Each mode names the browser that it needs.
        const needsChrome = input.message.includes('Google Chrome is not installed');
        const needsChromium = input.message.includes('Playwright Chromium is not installed');
        const description =
          needsChrome && !needsChromium
            ? 'Ask a human to install Google Chrome and to restart the MCP server.'
            : needsChromium && !needsChrome
              ? 'Ask a human to run "npx checkout-test-mcp init" and to restart the MCP server.'
              : 'Ask a human to install Google Chrome, or to run "npx checkout-test-mcp init", and to restart the MCP server.';
        actions.push({ kind: 'ask_human', description });
        break;
      }
      if (input.message?.includes("Executable doesn't exist")) {
        causes.push('The Playwright browser is not installed on the machine that runs the MCP server.');
        actions.push({
          kind: 'ask_human',
          description: 'Ask a human to run "npx playwright install chromium" and restart the MCP server.',
        });
        break;
      }
      causes.push('The browser crashed or closed. This is usually not a problem with the site.');
      actions.push({
        kind: 'wait_and_retry',
        description: 'Run the scenario again with a new idempotency_key.',
        after_s: 10,
      });
      break;
    case 'server_restarted':
      causes.push(
        'The MCP server stopped while this run was in progress. The server never repeats such a run.',
      );
      actions.push(rerun(input, 'Start a new run with a new idempotency_key if you still need the result.'));
      break;
  }

  if (input.hint) causes.push(`Scenario author hint: ${input.hint}`);
  return { category, likely_causes: causes, next_actions: actions };
}

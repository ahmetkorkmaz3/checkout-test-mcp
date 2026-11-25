import { ToolError } from '../errors/tool-error.js';
import type { RunRecord } from '../schemas/run.js';

export interface Regression {
  kind: 'step_failed' | 'outcome_failed' | 'new_console_error' | 'new_network_failure' | 'slower';
  step_id: string;
  description: string;
  baseline_value?: string;
  candidate_value?: string;
}

export interface CompareResult {
  verdict: 'regression' | 'fixed' | 'no_change' | 'both_failing' | 'inconclusive';
  summary: string;
  scenario_id: string;
  baseline: {
    run_id: string;
    target: string;
    verdict: NonNullable<RunRecord['verdict']>;
    finished_at: string;
  };
  candidate: {
    run_id: string;
    target: string;
    verdict: NonNullable<RunRecord['verdict']>;
    finished_at: string;
  };
  regressions: Regression[];
  fixes: Array<{ kind: string; step_id: string; description: string }>;
  step_changes: Array<{
    step_id: string;
    baseline_status: string;
    candidate_status: string;
    baseline_ms: number | null;
    candidate_ms: number | null;
  }>;
  warnings: string[];
}

function assertFinished(
  r: RunRecord,
  role: string,
): asserts r is RunRecord & { verdict: NonNullable<RunRecord['verdict']> } {
  if (r.status !== 'finished' || r.verdict === null) {
    throw new ToolError({
      code: 'RUN_NOT_FINISHED',
      message: `The ${role} run ${r.run_id} is still ${r.status}.`,
      likelyCause: 'compare_runs needs two finished runs.',
      retryable: true,
      nextActions: [
        {
          kind: 'call_tool',
          description: `Wait for the ${role} run to finish, then call compare_runs again.`,
          tool: 'get_run_result',
          arguments: { run_id: r.run_id, wait_s: 20 },
        },
      ],
    });
  }
}

/** Normalizes a URL for comparison: no query string, numeric path segments as ":n". */
function urlKey(url: string): string {
  return url.replace(/\?.*$/, '').replace(/\/\d+(?=\/|$)/g, '/:n');
}

export function compareRuns(baseline: RunRecord, candidate: RunRecord, slowdownPct: number): CompareResult {
  assertFinished(baseline, 'baseline');
  assertFinished(candidate, 'candidate');
  if (baseline.scenario_id !== candidate.scenario_id) {
    throw new ToolError({
      code: 'RUNS_NOT_COMPARABLE',
      message: `The runs use different scenarios: "${baseline.scenario_id}" and "${candidate.scenario_id}".`,
      likelyCause: 'compare_runs compares two runs of the same scenario.',
      nextActions: [
        {
          kind: 'call_tool',
          description: `Start a run of "${baseline.scenario_id}" on the candidate target, then compare.`,
          tool: 'run_scenario',
          arguments: { scenario_id: baseline.scenario_id, target: candidate.target },
        },
      ],
    });
  }

  const warnings: string[] = [];
  if (baseline.scenario_hash !== candidate.scenario_hash)
    warnings.push('The scenario file changed between the two runs.');
  if (JSON.stringify(baseline.params) !== JSON.stringify(candidate.params))
    warnings.push('The runs used different params.');
  if (baseline.options.timeout_multiplier !== candidate.options.timeout_multiplier) {
    warnings.push('The runs used different timeout_multiplier values.');
  }

  const bb = baseline.browser;
  const cb = candidate.browser;
  if (bb && cb && (bb.name !== cb.name || majorOf(bb.version) !== majorOf(cb.version))) {
    warnings.push(`The runs used different browsers: ${bb.name} ${bb.version} and ${cb.name} ${cb.version}.`);
  }

  const regressions: Regression[] = [];
  const fixes: CompareResult['fixes'] = [];
  const candSteps = new Map(candidate.steps.map((s) => [s.id, s]));
  const stepChanges: CompareResult['step_changes'] = [];

  for (const b of baseline.steps) {
    const c = candSteps.get(b.id);
    if (!c) {
      warnings.push(`Step "${b.id}" exists only in the baseline run.`);
      continue;
    }
    stepChanges.push({
      step_id: b.id,
      baseline_status: b.status,
      candidate_status: c.status,
      baseline_ms: b.duration_ms ?? null,
      candidate_ms: c.duration_ms ?? null,
    });
    if (b.status === 'passed' && c.status === 'failed') {
      regressions.push({
        kind: 'step_failed',
        step_id: b.id,
        description: `Step "${b.title}" passed in the baseline and failed in the candidate.${
          candidate.failure?.step_id === b.id
            ? ` ${candidate.failure.category}: ${candidate.failure.message}`
            : ''
        }`,
        baseline_value: 'passed',
        candidate_value: 'failed',
      });
    } else if (b.status === 'failed' && c.status === 'passed') {
      fixes.push({
        kind: 'step_fixed',
        step_id: b.id,
        description: `Step "${b.title}" failed in the baseline and passes now.`,
      });
    } else if (
      b.status === 'passed' &&
      c.status === 'passed' &&
      b.duration_ms !== undefined &&
      c.duration_ms !== undefined
    ) {
      const grow = c.duration_ms - b.duration_ms;
      if (grow > 1000 && b.duration_ms > 0 && (grow / b.duration_ms) * 100 > slowdownPct) {
        regressions.push({
          kind: 'slower',
          step_id: b.id,
          description: `Step "${b.title}" is ${Math.round((grow / b.duration_ms) * 100)}% slower.`,
          baseline_value: `${b.duration_ms} ms`,
          candidate_value: `${c.duration_ms} ms`,
        });
      }
    }
  }

  const candOutcome = new Map(candidate.outcome_checks.map((o) => [o.id, o]));
  for (const b of baseline.outcome_checks) {
    const c = candOutcome.get(b.id);
    if (!c) continue;
    if (b.status === 'passed' && c.status === 'failed') {
      regressions.push({
        kind: 'outcome_failed',
        step_id: b.id,
        description: `Outcome check "${b.id}" passed in the baseline and failed in the candidate.${c.message ? ` ${c.message}` : ''}`,
        baseline_value: 'passed',
        candidate_value: 'failed',
      });
    } else if (b.status === 'failed' && c.status === 'passed') {
      fixes.push({
        kind: 'outcome_fixed',
        step_id: b.id,
        description: `Outcome check "${b.id}" passes now.`,
      });
    }
  }

  const baseConsole = new Set(baseline.console_errors.filter((e) => e.level === 'error').map((e) => e.text));
  for (const e of candidate.console_errors) {
    if (e.level === 'error' && !baseConsole.has(e.text)) {
      regressions.push({
        kind: 'new_console_error',
        step_id: e.step_id,
        description: `New console error: ${e.text}`,
      });
    }
  }
  const netKey = (n: RunRecord['network_failures'][number]) =>
    `${n.method} ${urlKey(n.url)} ${n.status ?? n.failure_text}`;
  const baseNet = new Set(baseline.network_failures.map(netKey));
  for (const n of candidate.network_failures) {
    if (!baseNet.has(netKey(n))) {
      regressions.push({
        kind: 'new_network_failure',
        step_id: n.step_id,
        description: `New network failure: ${n.method} ${n.url} -> ${n.status ?? n.failure_text}`,
      });
    }
  }

  const untested = (v: string) => v === 'error' || v === 'blocked' || v === 'cancelled';
  let verdict: CompareResult['verdict'];
  if (untested(baseline.verdict) || untested(candidate.verdict)) verdict = 'inconclusive';
  else if (regressions.some((r) => r.kind === 'step_failed' || r.kind === 'outcome_failed'))
    verdict = 'regression';
  else if (baseline.verdict === 'failed' && candidate.verdict === 'passed') verdict = 'fixed';
  else if (baseline.verdict === 'failed' && candidate.verdict === 'failed') verdict = 'both_failing';
  else verdict = regressions.length > 0 ? 'regression' : 'no_change';

  const summaryParts: Record<CompareResult['verdict'], string> = {
    regression: `Regression: ${regressions.length} problem(s) in the candidate run that the baseline run did not have. First: ${regressions[0]?.description ?? ''}`,
    fixed: `The candidate run passes. The baseline run failed. ${fixes.length} fix(es) found.`,
    no_change: 'No regression. Both runs have the same step and outcome results.',
    both_failing: `Both runs failed. Baseline failed at "${baseline.failure?.step_id}", candidate failed at "${candidate.failure?.step_id}".`,
    inconclusive: `Inconclusive: one run did not test the site (baseline verdict "${baseline.verdict}", candidate verdict "${candidate.verdict}").`,
  };

  return {
    verdict,
    summary: summaryParts[verdict],
    scenario_id: baseline.scenario_id,
    baseline: {
      run_id: baseline.run_id,
      target: baseline.target,
      verdict: baseline.verdict,
      finished_at: baseline.finished_at ?? '',
    },
    candidate: {
      run_id: candidate.run_id,
      target: candidate.target,
      verdict: candidate.verdict,
      finished_at: candidate.finished_at ?? '',
    },
    regressions,
    fixes,
    step_changes: stepChanges,
    warnings,
  };
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

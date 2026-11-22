import type { RunRecord } from '../schemas/run.js';

/** Two to four sentences: what ran, what happened, what to do next. */
export function buildSummary(r: RunRecord): string {
  const head = `Scenario "${r.scenario_id}" on target "${r.target}"`;
  if (r.status === 'queued') return `${head} is queued. Call get_run_result with wait_s 20.`;
  if (r.status === 'running') {
    return `${head} is running: ${r.progress.completed_steps} of ${r.progress.total_steps} steps done${
      r.progress.current_step_id ? `, now at "${r.progress.current_step_id}"` : ''
    }. Call get_run_result with wait_s 20.`;
  }
  const secs = r.duration_ms !== null ? ` in ${(r.duration_ms / 1000).toFixed(1)} s` : '';
  const passedSteps = r.steps.filter((s) => s.status === 'passed').length;
  const passedChecks = r.outcome_checks.filter((o) => o.status === 'passed').length;
  if (r.verdict === 'passed') {
    return `${head} passed${secs}. ${passedSteps} of ${r.steps.length} steps and ${passedChecks} of ${r.outcome_checks.length} outcome checks passed.`;
  }
  const f = r.failure;
  if (!f) return `${head} finished with verdict "${r.verdict}"${secs}.`;
  const cause = f.likely_causes[0] ? ` Most likely cause: ${f.likely_causes[0]}` : '';
  const next = f.next_actions[0] ? ` Next: ${f.next_actions[0].description}` : '';
  return `${head} finished with verdict "${r.verdict}"${secs} at "${f.step_id}" (${f.step_title}): ${f.category}. ${f.message}${cause}${next}`;
}

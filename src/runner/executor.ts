import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserContext, errors, type Locator, type Page } from 'playwright';
import { cardInputs } from '../safety/card-inputs.js';
import { containsUnregisteredCardNumber } from '../safety/cards.js';
import { hostOf, isUrlAllowed } from '../safety/hosts.js';
import { type Redactor, redactQuery } from '../safety/secrets.js';
import { readJsonPath, renderCaptured, TemplateError } from '../scenarios/template.js';
import type { FailureCategory, Verdict } from '../schemas/common.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';
import type {
  BlockedRequest,
  ConsoleError,
  Failure,
  NetworkFailure,
  OutcomeCheckResult,
  RunOptions,
  StepResult,
} from '../schemas/run.js';
import type { Action, Capture, Expectation, OutcomeCheck, Scenario, Step } from '../schemas/scenario.js';
import { openGuardedContext, stripUserInfo } from './browser.js';
import { classify } from './classify.js';
import { PROXY_ERROR_HEADER } from './guard-proxy.js';
import { describeLocator, scopeFor, toLocator } from './locator.js';
import {
  describeResponseMatch,
  type RecordedResponse,
  responseMatches,
  statusMatches,
  urlMatchesGlob,
} from './match.js';

export interface ExecuteInput {
  runDir: string;
  scenario: Scenario;
  /** Steps and outcome checks with all templates rendered. Never stored. */
  steps: Step[];
  outcome: OutcomeCheck[];
  target: TargetConfig;
  targetName: string;
  config: Pick<ResolvedConfig, 'production_hosts' | 'headless'>;
  options: RunOptions;
  httpCredentials?: { username: string; password: string };
  redactor: Redactor;
  /** Live card numbers of this run. The card guard lets them through. Empty for a test card run. */
  allowedCardNumbers: ReadonlySet<string>;
  onProgress: (p: { completed_steps: number; current_step_id: string | null; steps: StepResult[] }) => void;
}

export interface ExecuteOutput {
  verdict: Verdict;
  failure: Failure | null;
  steps: StepResult[];
  outcome_checks: OutcomeCheckResult[];
  console_errors: ConsoleError[];
  network_failures: NetworkFailure[];
  blocked_requests: BlockedRequest[];
  screenshots: { step_id: string; path: string; uri: string }[];
  trace_path: string | null;
}

/** A step or outcome check did not pass. */
class StepFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    readonly expected?: string,
    readonly actual?: string,
  ) {
    super(message);
  }
}

const BLOCKED_BY_GUARD = 'net::ERR_BLOCKED_BY_CLIENT';
// ERR_TUNNEL_CONNECTION_FAILED: the guard proxy could not open a tunnel to an allowed host. A host that the
// proxy refused is a blocked navigation, which the runner checks first.
const UNREACHABLE =
  /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_|ERR_SSL_/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECRET_INPUTS = 'input[type=password i], input[autocomplete="one-time-code" i]';

/**
 * Screenshot masks for password, card, and one-time code inputs in every frame of the page.
 * A card iframe that no step addresses, or a nested frame, is masked too. Card inputs use the shared
 * rule in src/safety/card-inputs.ts, so a card input without autocomplete is masked too.
 */
export function sensitiveMask(page: Page): Locator[] {
  return page.frames().flatMap((f) => [f.locator(SECRET_INPUTS), cardInputs(f)]);
}

/** Stops the run before it fills or captures a card number that is not a test card or a live card of this run. */
export function guardCardValue(value: string, allowed: ReadonlySet<string>): void {
  if (containsUnregisteredCardNumber(value, allowed)) {
    throw new StepFailure(
      'blocked_by_safety',
      'The run stopped before it filled a value that looks like a card number outside the test card registry.',
    );
  }
}

export async function executeRun(input: ExecuteInput): Promise<ExecuteOutput> {
  const { scenario, target, options, redactor } = input;
  const mult = options.timeout_multiplier;
  const stepTimeout = (override?: number) => Math.round((override ?? scenario.timeouts.step_ms) * mult);
  const runTimeoutMs = Math.round(scenario.timeouts.run_ms * mult);

  const stepResults: StepResult[] = input.steps.map((s) => ({ id: s.id, title: s.title, status: 'pending' }));
  const outcomeResults: OutcomeCheckResult[] = input.outcome.map((o) => ({ id: o.id, status: 'not_run' }));
  const responses: RecordedResponse[] = [];
  const consoleMap = new Map<string, ConsoleError>();
  const networkFailures: NetworkFailure[] = [];
  const blocked: BlockedRequest[] = [];
  const screenshots: ExecuteOutput['screenshots'] = [];
  let stepIndex = 0;
  let currentStepId = 'setup';
  let blockedNavigation: string | null = null;
  let runTimedOut = false;
  let tracePath: string | null = null;
  /** Values read from responses by "capture". Never stored or returned. */
  const captured = new Map<string, string>();

  const consoleIgnored = (text: string) => scenario.ignore.console.some((i) => text.includes(i.pattern));
  const networkIgnored = (url: string) => scenario.ignore.network.some((i) => urlMatchesGlob(url, i.url));

  /** Closes the browser and its guard proxy. */
  let closeGuarded: (() => Promise<void>) | undefined;
  let proxyErrorToken: string | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let failure: Failure | null = null;

  async function screenshot(stepId: string, n: number): Promise<string | undefined> {
    const p = page;
    if (!p || p.isClosed()) return undefined;
    const file = path.join(input.runDir, `${String(n).padStart(2, '0')}-${stepId}.png`);
    try {
      await p.screenshot({ path: file, mask: sensitiveMask(p), timeout: 10_000 });
      screenshots.push({ step_id: stepId, path: file, uri: pathToFileURL(file).toString() });
      return file;
    } catch {
      return undefined;
    }
  }

  function guardValue(value: string): void {
    guardCardValue(value, input.allowedCardNumbers);
  }

  function checkBlockedNavigation(): void {
    if (blockedNavigation) {
      throw new StepFailure(
        'blocked_by_safety',
        `The page tried to open ${blockedNavigation}, which is not an allowed host for target "${input.targetName}".`,
      );
    }
  }

  async function perform(p: Page, action: Action | Step, timeout: number): Promise<void> {
    const scope = scopeFor(p, action.within);
    if (action.goto !== undefined) {
      try {
        const res = await p.goto(action.goto, { timeout, waitUntil: 'load' });
        checkBlockedNavigation();
        // Only the guard proxy knows its token, so a site cannot fake this error.
        if (res && res.status() === 502 && (await res.headerValue(PROXY_ERROR_HEADER)) === proxyErrorToken) {
          throw new StepFailure(
            'target_unreachable',
            `The guard proxy could not reach ${redactQuery(res.url())}.`,
          );
        }
        if (res && res.status() >= 500) {
          throw new StepFailure(
            'navigation_failed',
            `The page ${redactQuery(res.url())} returned HTTP ${res.status()}.`,
          );
        }
      } catch (err) {
        if (err instanceof StepFailure) throw err;
        checkBlockedNavigation();
        const msg = (err as Error).message;
        if (msg.includes('ERR_BLOCKED_BY_CLIENT')) {
          throw new StepFailure(
            'blocked_by_safety',
            `Navigation to ${action.goto} was blocked by the host guard.`,
          );
        }
        if (UNREACHABLE.test(msg)) throw new StepFailure('target_unreachable', firstLine(msg));
        if (err instanceof errors.TimeoutError)
          throw new StepFailure('timeout', `The page ${action.goto} did not load within ${timeout} ms.`);
        throw new StepFailure('navigation_failed', firstLine(msg));
      }
      return;
    }
    const run = async (desc: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof errors.TimeoutError) {
          throw new StepFailure(
            'element_not_found',
            `No usable element matched ${desc} within ${timeout} ms.`,
            desc,
          );
        }
        throw err;
      }
    };
    if (action.click) {
      const spec = action.click;
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().click({ timeout }),
      );
    } else if (action.fill) {
      const spec = action.fill;
      const value = String(action.value ?? '');
      guardValue(value);
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().fill(value, { timeout }),
      );
    } else if (action.select) {
      const spec = action.select;
      const option = action.option ?? '';
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().selectOption(option, { timeout }),
      );
    } else if (action.check) {
      const spec = action.check;
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().check({ timeout }),
      );
    } else if (action.uncheck) {
      const spec = action.uncheck;
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().uncheck({ timeout }),
      );
    } else if (action.press) {
      const spec = action.press;
      const key = action.key ?? 'Enter';
      await run(describeLocator(spec, action.within), () =>
        toLocator(scope, spec).first().press(key, { timeout }),
      );
    } else if (action.fill_form) {
      for (const f of action.fill_form) {
        const desc = describeLocator(f.field, action.within);
        const loc = toLocator(scope, f.field).first();
        if ('value' in f) {
          guardValue(f.value);
          await run(desc, () => loc.fill(f.value, { timeout }));
        } else {
          await run(desc, () => loc.selectOption(f.select, { timeout }));
        }
      }
    } else if (action.wait_for) {
      await check(p, action.wait_for, timeout, stepIndex);
    }
    checkBlockedNavigation();
  }

  async function check(
    p: Page,
    exp: Expectation | OutcomeCheck,
    defaultTimeout: number,
    sinceStep: number,
  ): Promise<void> {
    const timeout = exp.timeout_ms ? Math.round(exp.timeout_ms * mult) : defaultTimeout;
    const deadline = Date.now() + timeout;
    const resolveTarget = (t: NonNullable<Expectation['visible']>) =>
      'locator' in t
        ? {
            loc: toLocator(scopeFor(p, t.within), t.locator).first(),
            desc: describeLocator(t.locator, t.within),
          }
        : { loc: toLocator(p, t).first(), desc: describeLocator(t) };

    if (exp.visible) {
      const { loc, desc } = resolveTarget(exp.visible);
      try {
        await loc.waitFor({ state: 'visible', timeout });
      } catch (err) {
        if (err instanceof errors.TimeoutError) {
          throw new StepFailure(
            'element_not_found',
            `No visible element matched ${desc} within ${timeout} ms.`,
            `visible: ${desc}`,
            `page url: ${p.url()}`,
          );
        }
        throw err;
      }
    } else if (exp.hidden) {
      const { loc, desc } = resolveTarget(exp.hidden);
      try {
        await loc.waitFor({ state: 'hidden', timeout });
      } catch (err) {
        if (err instanceof errors.TimeoutError) {
          throw new StepFailure(
            'assertion_failed',
            `Element ${desc} is still visible after ${timeout} ms.`,
            `hidden: ${desc}`,
            'visible',
          );
        }
        throw err;
      }
    } else if (exp.text) {
      const t = exp.text;
      const { within, equals, contains, matches, ...spec } = t;
      const desc = describeLocator(spec, within);
      const loc = toLocator(scopeFor(p, within), spec).first();
      const expected =
        equals !== undefined
          ? `equals "${equals}"`
          : contains !== undefined
            ? `contains "${contains}"`
            : `matches /${matches}/`;
      const ok = (s: string) =>
        equals !== undefined
          ? s === equals
          : contains !== undefined
            ? s.includes(contains)
            : new RegExp(matches ?? '').test(s);
      let actual: string | null = null;
      while (true) {
        actual = await loc
          .textContent({ timeout: Math.max(100, Math.min(1000, deadline - Date.now())) })
          .catch(() => null);
        if (actual !== null && ok(actual.trim())) return;
        if (Date.now() >= deadline) break;
        await sleep(200);
      }
      if (actual === null) {
        throw new StepFailure(
          'element_not_found',
          `No element matched ${desc} within ${timeout} ms.`,
          `${desc} ${expected}`,
        );
      }
      throw new StepFailure(
        'assertion_failed',
        `Text of ${desc} did not match.`,
        expected,
        `"${actual.trim()}"`,
      );
    } else if (exp.url) {
      const u = exp.url;
      const ok = (url: string) =>
        u.equals !== undefined
          ? url === u.equals
          : u.regex !== undefined
            ? new RegExp(u.regex).test(url)
            : urlMatchesGlob(url, u.matches ?? '');
      while (!ok(p.url())) {
        if (Date.now() >= deadline) {
          const want = u.equals ?? u.regex ?? u.matches ?? '';
          throw new StepFailure('assertion_failed', 'The page URL did not match.', `url ${want}`, p.url());
        }
        await sleep(200);
      }
    } else if (exp.response) {
      const m = exp.response;
      while (!responses.some((r) => r.stepIndex >= sinceStep && responseMatches(r, m))) {
        if (Date.now() >= deadline) {
          const other = responses.filter((r) => r.stepIndex >= sinceStep && responseMatches(r, m, false));
          const actual = other.length
            ? other.map((r) => `${r.method} ${redactQuery(r.url)} -> ${r.status}`).join(', ')
            : 'no matching request';
          throw new StepFailure(
            'unexpected_response',
            `Expected response ${describeResponseMatch(m)} did not arrive.`,
            describeResponseMatch(m),
            actual,
          );
        }
        await sleep(100);
      }
    } else if (exp.no_response) {
      const m = exp.no_response;
      await sleep(Math.min(1000, timeout));
      const hit = responses.find((r) => responseMatches(r, m));
      if (hit) {
        throw new StepFailure(
          'unexpected_response',
          `A forbidden response arrived: ${hit.method} ${redactQuery(hit.url)} -> ${hit.status}.`,
          `no ${describeResponseMatch(m)}`,
          `${hit.method} ${redactQuery(hit.url)} -> ${hit.status}`,
        );
      }
    }
  }

  async function capture(c: Capture, timeout: number, sinceStep: number): Promise<void> {
    const deadline = Date.now() + timeout;
    const where = describeResponseMatch(c.from_response);
    const source = c.body_regex !== undefined ? `body_regex /${c.body_regex}/` : `"${c.json_path}"`;
    const checked = new Set<RecordedResponse>();
    let value: string | undefined;
    while (value === undefined) {
      const hit = responses.find(
        (r) => !checked.has(r) && r.stepIndex >= sinceStep && r.body && responseMatches(r, c.from_response),
      );
      if (!hit) {
        if (Date.now() >= deadline) {
          // A body_regex skips bodies that do not match, so name that case on its own.
          const seen = checked.size > 0;
          throw new StepFailure(
            'unexpected_response',
            seen
              ? `Capture "${c.name}": no body of ${where} matched ${source} within ${timeout} ms.`
              : `Capture "${c.name}": response ${where} did not arrive within ${timeout} ms.`,
            seen ? source : where,
            seen ? `${checked.size} response(s) without a match` : 'no matching response',
          );
        }
        await sleep(100);
        continue;
      }
      checked.add(hit);
      const text = await hit.body;
      value = c.body_regex !== undefined ? fromRegex(c.body_regex, text) : fromJson(c, where, text);
    }
    guardValue(value);
    redactor.register(value);
    if (c.pattern !== undefined && !new RegExp(c.pattern).test(value)) {
      throw new StepFailure(
        'assertion_failed',
        `Capture "${c.name}": the value from ${source} does not match /${c.pattern}/.`,
        `/${c.pattern}/`,
        `${value.length} characters`,
      );
    }
    captured.set(c.name, value);
  }

  /** First capture group of the regex in the body, or undefined to try the next response. */
  function fromRegex(regex: string, text: string | null | undefined): string | undefined {
    const group = text ? new RegExp(regex).exec(text)?.[1] : undefined;
    return group === undefined || group === '' ? undefined : group;
  }

  /** The JSON value at the path. The first matching response decides, so a bad body fails the step. */
  function fromJson(c: Capture, where: string, text: string | null | undefined): string {
    const jsonPath = c.json_path ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text ?? '');
    } catch {
      throw new StepFailure(
        'unexpected_response',
        `Capture "${c.name}": the body of ${where} is not JSON.`,
        'JSON body',
        text === null ? 'no body' : 'not JSON',
      );
    }
    const raw = readJsonPath(json, jsonPath);
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      // Name only the path and the type. The body can hold personal data.
      throw new StepFailure(
        'unexpected_response',
        `Capture "${c.name}": "${jsonPath}" is not a string or number in the body of ${where}.`,
        `${jsonPath}: string or number`,
        raw === undefined ? 'missing' : Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw,
      );
    }
    return String(raw);
  }

  function withCaptured<T>(value: T): T {
    try {
      return renderCaptured(value, captured);
    } catch (err) {
      if (err instanceof TemplateError) throw new StepFailure('assertion_failed', err.message);
      throw err;
    }
  }

  function buildFailure(
    err: unknown,
    stepId: string,
    stepTitle: string,
    urlBefore: string | undefined,
    hint: string | undefined,
    isOutcome: boolean,
    shot: string | undefined,
  ): Failure {
    let category: FailureCategory;
    let message: string;
    let expected: string | undefined;
    let actual: string | undefined;
    if (runTimedOut) {
      category = 'timeout';
      message = `The run did not finish within ${runTimeoutMs} ms.`;
    } else if (err instanceof StepFailure) {
      ({ category, message, expected, actual } = err);
    } else if (err instanceof errors.TimeoutError) {
      category = 'timeout';
      message = firstLine((err as Error).message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      category = 'browser_error';
      message = firstLine(msg);
    }
    const urlAfter = page && !page.isClosed() ? page.url() : undefined;
    const serverErrors = networkFailures
      .filter((n) => n.step_id === stepId && n.status !== null && n.status >= 500)
      .map((n) => `${n.method} ${n.url} -> ${n.status}`);
    const c = classify({
      category,
      scenarioId: scenario.id,
      target: input.targetName,
      stepId,
      urlBefore,
      urlAfter,
      serverErrorsInStep: serverErrors,
      blockedInStep: blocked.filter((b) => b.step_id === stepId).map((b) => hostOf(b.url)),
      hint,
      timeoutMultiplier: mult,
      isOutcomeCheck: isOutcome,
      message,
    });
    return {
      step_id: stepId,
      step_title: stepTitle,
      category: c.category,
      message,
      ...(expected !== undefined ? { expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
      likely_causes: c.likely_causes,
      next_actions: c.next_actions,
      ...(shot ? { screenshot: shot } : {}),
      ...(urlAfter ? { page_url: redactQuery(urlAfter) } : {}),
    };
  }

  const main = async () => {
    const guarded = await openGuardedContext({
      config: input.config,
      target,
      ...(input.httpCredentials ? { httpCredentials: input.httpCredentials } : {}),
      onBlocked: (url, frame, isNavigation) => {
        const entry = { url: redactQuery(stripUserInfo(url)), step_id: currentStepId };
        // Chromium can open several CONNECT tunnels for one https host. One entry for each step is enough.
        if (!blocked.some((b) => b.url === entry.url && b.step_id === entry.step_id)) blocked.push(entry);
        // Only a navigation of the run's own page stops the run. A popup has no frame yet, so it is only listed.
        if (isNavigation && page && frame === page.mainFrame())
          blockedNavigation = redactQuery(stripUserInfo(url));
      },
    });
    // After a run timeout the cleanup has run already, so this browser must close here.
    if (runTimedOut) {
      await guarded.close();
      return;
    }
    closeGuarded = guarded.close;
    proxyErrorToken = guarded.proxyErrorToken;
    context = guarded.context;
    if (options.trace) await context.tracing.start({ screenshots: true, snapshots: true });

    page = await context.newPage();
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const text = redactor.redact(msg.text()).slice(0, 500);
      if (consoleIgnored(text)) return;
      addConsole(type === 'error' ? 'error' : 'warning', text, msg.location().url);
    });
    page.on('pageerror', (err) => {
      const text = redactor.redact(`Uncaught ${err.name}: ${err.message}`).slice(0, 500);
      if (!consoleIgnored(text)) addConsole('error', text, undefined);
    });
    // The route handler sees only the first URL of a redirect chain. The proxy refuses a later hop to a
    // host outside the allowlist, but it has no frame. This listener marks such a hop of the main frame.
    page.on('request', (req) => {
      if (!page || !req.isNavigationRequest() || !/^https?:/.test(req.url())) return;
      if (isUrlAllowed(req.url(), target, input.config)) return;
      let frame: ReturnType<typeof req.frame> | null = null;
      try {
        frame = req.frame();
      } catch {
        frame = null;
      }
      if (frame === page.mainFrame()) blockedNavigation = redactQuery(stripUserInfo(req.url()));
    });
    page.on('response', (res) => {
      const req = res.request();
      // A response from a host outside the allowlist is the 403 of the guard proxy, not a site failure.
      if (!isUrlAllowed(res.url(), target, input.config)) return;
      const rec: RecordedResponse = { method: req.method(), url: res.url(), status: res.status(), stepIndex };
      const specs = input.steps[stepIndex]?.capture ?? [];
      if (specs.some((c) => responseMatches(rec, c.from_response))) rec.body = res.text().catch(() => null);
      responses.push(rec);
      if (res.status() >= 400 && !networkIgnored(res.url())) {
        networkFailures.push({
          method: req.method(),
          url: redactQuery(res.url()),
          status: res.status(),
          resource_type: req.resourceType(),
          step_id: currentStepId,
          relevant: false,
        });
      }
    });
    page.on('requestfailed', (req) => {
      // Only the route guard aborts with this error. Chromium can add a suffix, such as ".Inspector" for a fetch.
      if (req.failure()?.errorText.startsWith(BLOCKED_BY_GUARD) || networkIgnored(req.url())) return;
      // A request to a host outside the allowlist failed at the guard proxy.
      if (!isUrlAllowed(req.url(), target, input.config)) return;
      networkFailures.push({
        method: req.method(),
        url: redactQuery(req.url()),
        status: null,
        failure_text: req.failure()?.errorText ?? 'unknown',
        resource_type: req.resourceType(),
        step_id: currentStepId,
        relevant: false,
      });
    });

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i] as Step;
      const result = stepResults[i] as StepResult;
      stepIndex = i;
      currentStepId = step.id;
      result.status = 'running';
      input.onProgress({ completed_steps: i, current_step_id: step.id, steps: stepResults });
      const started = Date.now();
      const urlBefore = page.url();
      const timeout = stepTimeout(step.timeout_ms);
      try {
        const live = withCaptured(step);
        await perform(page, live, timeout);
        for (const t of live.then ?? []) await perform(page, t, timeout);
        for (const e of live.expect ?? []) await check(page, e, timeout, i);
        for (const c of live.capture ?? []) await capture(c, timeout, i);
        result.status = 'passed';
        result.duration_ms = Date.now() - started;
        result.url_after = redactQuery(page.url());
        if (options.capture === 'every_step') {
          const shot = await screenshot(step.id, i + 1);
          if (shot) result.screenshot = shot;
        }
      } catch (err) {
        result.status = 'failed';
        result.duration_ms = Date.now() - started;
        const shot = await screenshot(step.id, i + 1);
        if (shot) result.screenshot = shot;
        if (!page.isClosed()) result.url_after = redactQuery(page.url());
        failure = buildFailure(err, step.id, step.title, urlBefore, step.on_failure?.hint, false, shot);
        for (const r of stepResults.slice(i + 1)) r.status = 'skipped';
        return;
      }
    }

    stepIndex = input.steps.length;
    currentStepId = 'outcome';
    input.onProgress({ completed_steps: input.steps.length, current_step_id: 'outcome', steps: stepResults });
    for (let i = 0; i < input.outcome.length; i++) {
      const o = input.outcome[i] as OutcomeCheck;
      const r = outcomeResults[i] as OutcomeCheckResult;
      try {
        await check(page, withCaptured(o), stepTimeout(), 0);
        r.status = 'passed';
      } catch (err) {
        r.status = 'failed';
        r.message = err instanceof Error ? firstLine(err.message) : String(err);
        if (!failure) {
          const shot = await screenshot(`outcome-${o.id}`, input.steps.length + 1);
          failure = buildFailure(err, o.id, `Outcome check: ${o.id}`, undefined, undefined, true, shot);
        }
      }
    }
  };

  function addConsole(level: 'error' | 'warning', text: string, sourceUrl: string | undefined): void {
    const key = `${level}|${currentStepId}|${text}`;
    const existing = consoleMap.get(key);
    if (existing) existing.count++;
    else {
      consoleMap.set(key, {
        level,
        text,
        ...(sourceUrl ? { source_url: redactQuery(sourceUrl) } : {}),
        step_id: currentStepId,
        count: 1,
        relevant: false,
      });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), runTimeoutMs);
  });

  let fatal: unknown;
  try {
    const mainPromise = main().then(() => 'done' as const);
    // After a run timeout the browser closes and main() rejects. That rejection is expected.
    mainPromise.catch(() => {});
    const outcome = await Promise.race([mainPromise, timeoutPromise]);
    if (outcome === 'timeout') {
      runTimedOut = true;
      const idx = stepResults.findIndex((s) => s.status === 'running');
      const step = idx >= 0 ? (input.steps[idx] as Step) : undefined;
      const shot = await screenshot(step?.id ?? 'timeout', idx + 1);
      failure = buildFailure(
        null,
        step?.id ?? currentStepId,
        step?.title ?? 'Run',
        undefined,
        step?.on_failure?.hint,
        false,
        shot,
      );
      if (idx >= 0) {
        (stepResults[idx] as StepResult).status = 'failed';
        for (const r of stepResults.slice(idx + 1)) r.status = 'skipped';
      }
    }
  } catch (err) {
    fatal = err;
  } finally {
    clearTimeout(timer);
    if (context && options.trace) {
      tracePath = path.join(input.runDir, 'trace.zip');
      await context.tracing.stop({ path: tracePath }).catch(() => {
        tracePath = null;
      });
    }
    await closeGuarded?.();
  }

  if (fatal && !failure) {
    failure = buildFailure(fatal, currentStepId, 'Browser setup', undefined, undefined, false, undefined);
  }

  // Relevance: the failing step and the step before it, plus any 5xx.
  const failIdx = failure ? input.steps.findIndex((s) => s.id === (failure as Failure).step_id) : -1;
  const relevantSteps = new Set<string>();
  if (failure) {
    relevantSteps.add(failure.step_id);
    if (failIdx > 0) relevantSteps.add((input.steps[failIdx - 1] as Step).id);
    if (failIdx < 0) relevantSteps.add('outcome');
  }
  const consoleErrors = [...consoleMap.values()].map((c) => ({
    ...c,
    relevant: relevantSteps.has(c.step_id) && c.level === 'error',
  }));
  const nets = networkFailures.map((n) => ({
    ...n,
    relevant: relevantSteps.has(n.step_id) || (n.status !== null && statusMatches(n.status, '5xx')),
  }));

  const verdict: Verdict = !failure
    ? 'passed'
    : failure.category === 'blocked_by_safety'
      ? 'blocked'
      : ['target_unreachable', 'browser_error', 'server_restarted'].includes(failure.category)
        ? 'error'
        : 'failed';

  return redactExecuteOutput(redactor, {
    verdict,
    failure,
    steps: stepResults,
    outcome_checks: outcomeResults,
    console_errors: consoleErrors,
    network_failures: nets,
    blocked_requests: blocked,
    screenshots,
    trace_path: tracePath,
  });
}

/**
 * Redacts registered values in the whole output. failure.expected and failure.actual quote page text,
 * so they also lose a CVC that stands alone.
 */
export function redactExecuteOutput(redactor: Redactor, out: ExecuteOutput): ExecuteOutput {
  const redacted = redactor.redactDeep(out);
  const f = redacted.failure;
  if (!f) return redacted;
  return {
    ...redacted,
    failure: {
      ...f,
      ...(f.expected !== undefined ? { expected: redactor.redactFailureText(f.expected) } : {}),
      ...(f.actual !== undefined ? { actual: redactor.redactFailureText(f.actual) } : {}),
    },
  };
}

function firstLine(msg: string): string {
  return (msg.split('\n')[0] ?? msg).slice(0, 400);
}

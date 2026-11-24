import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { ToolError } from '../errors/tool-error.js';
import type { Logger } from '../logger.js';
import { classify } from '../runner/classify.js';
import { type ExecuteInput, type ExecuteOutput, executeRun } from '../runner/executor.js';
import { containsCardNumber, luhnValid } from '../safety/cards.js';
import { isProductionTarget } from '../safety/hosts.js';
import { PRODUCTION_WARNING } from '../safety/production.js';
import { looksLikeSecret, Redactor } from '../safety/secrets.js';
import { conditionsPass } from '../scenarios/expand.js';
import { LIVE_CARD_PREFIX, type RunCard, resolveParams } from '../scenarios/params.js';
import type { LoadedScenario, ScenarioRegistry } from '../scenarios/registry.js';
import { capturedPlaceholders, collectTokens, renderDeep, TemplateError } from '../scenarios/template.js';
import type { ParamValue } from '../schemas/common.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';
import { RunOptions, type RunRecord } from '../schemas/run.js';
import type { OutcomeCheck, Step } from '../schemas/scenario.js';
import { closest } from '../util/closest.js';
import { BrowserSlots } from './browser-slots.js';
import type { RunStore } from './store.js';
import { buildSummary } from './summary.js';

export interface StartRunInput {
  target: string;
  scenario_id: string;
  params: Record<string, ParamValue>;
  idempotency_key: string;
  options?: Partial<RunOptions>;
  /** The user said yes to this run on a production target. It is not part of the request hash. */
  confirm_production?: boolean;
}

export interface RunManagerDeps {
  config: ResolvedConfig;
  registry: ScenarioRegistry;
  store: RunStore;
  logger: Logger;
  execute?: (input: ExecuteInput) => Promise<ExecuteOutput>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Shared with InspectionManager. Default: a new set of max_parallel_runs slots. */
  slots?: BrowserSlots;
}

interface Prepared {
  record: RunRecord;
  loaded: LoadedScenario;
  target: TargetConfig;
  steps: Step[];
  outcome: OutcomeCheck[];
  redactor: Redactor;
  allowedCardNumbers: ReadonlySet<string>;
  httpCredentials: { username: string; password: string } | undefined;
}

/** The live cards of a target with empty values. resolveParams checks ids and behaviour with them. */
function liveCardPlaceholders(target: TargetConfig): Record<string, RunCard> {
  const out: Record<string, RunCard> = {};
  for (const [name, entry] of Object.entries(target.live_cards)) {
    const id = `${LIVE_CARD_PREFIX}${name}`;
    out[id] = {
      id,
      provider: 'live',
      brand: 'unknown',
      number: '',
      expiry: '',
      cvc: '',
      behaviour: entry.behaviour,
      description: entry.description,
    };
  }
  return out;
}

export function newRunId(): string {
  return `run_${randomBytes(12).toString('base64url')}`;
}

export class RunManager {
  private readonly events = new EventEmitter();
  private readonly queue: Prepared[] = [];
  private readonly execute: (input: ExecuteInput) => Promise<ExecuteOutput>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly active = new Set<Promise<void>>();
  private readonly slots: BrowserSlots;

  constructor(private readonly deps: RunManagerDeps) {
    this.execute = deps.execute ?? executeRun;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.events.setMaxListeners(0);
    this.slots = deps.slots ?? new BrowserSlots(deps.config.max_parallel_runs);
    // An inspection that ends frees a slot. A queued run can then start.
    this.slots.onFree(() => this.pump());
  }

  /** Call once at startup. Marks runs that were in progress as finished with verdict "error". */
  async recover(interrupted: RunRecord[]): Promise<void> {
    for (const r of interrupted) {
      const c = classify({
        category: 'server_restarted',
        scenarioId: r.scenario_id,
        target: r.target,
        stepId: r.progress.current_step_id ?? 'setup',
        urlBefore: undefined,
        urlAfter: undefined,
        serverErrorsInStep: [],
        blockedInStep: [],
        hint: undefined,
        timeoutMultiplier: r.options.timeout_multiplier,
        isOutcomeCheck: false,
      });
      const finished: RunRecord = {
        ...r,
        status: 'finished',
        verdict: 'error',
        finished_at: this.now().toISOString(),
        failure: {
          step_id: r.progress.current_step_id ?? 'setup',
          step_title: 'Run interrupted',
          category: c.category,
          message: 'The server stopped while this run was in progress. The run was not repeated.',
          likely_causes: c.likely_causes,
          next_actions: c.next_actions,
        },
        steps: r.steps.map((s) =>
          s.status === 'pending' || s.status === 'running' ? { ...s, status: 'skipped' } : s,
        ),
      };
      finished.summary = buildSummary(finished);
      await this.deps.store.save(finished);
    }
  }

  listTargets(): Array<[string, TargetConfig]> {
    return Object.entries(this.deps.config.targets);
  }

  get(runId: string): RunRecord {
    const r = this.deps.store.get(runId);
    if (!r) {
      throw new ToolError({
        code: 'RUN_NOT_FOUND',
        message: `Run "${runId}" does not exist on this server.`,
        likelyCause: 'The run id is wrong, or the run belongs to another server with a different runs_dir.',
        nextActions: [
          {
            kind: 'change_argument',
            description: 'Use the run_id exactly as run_scenario returned it.',
          },
        ],
      });
    }
    return r;
  }

  /** Resolves when the run record changes, or after `ms`. */
  async waitForChange(runId: string, ms: number): Promise<RunRecord> {
    const current = this.get(runId);
    if (ms <= 0 || current.status === 'finished') return current;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(runId, done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.on(runId, done);
    });
    return this.get(runId);
  }

  async start(input: StartRunInput): Promise<{ record: RunRecord; reused: boolean }> {
    this.checkArgumentSafety(input);
    const options = RunOptions.parse(input.options ?? {});

    // The hash uses the arguments as sent, so a retry matches before any other work.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({ t: input.target, s: input.scenario_id, p: sortKeys(input.params), o: options }),
      )
      .digest('hex')
      .slice(0, 32);
    const early = this.checkExisting(input.idempotency_key, requestHash);
    if (early) return { record: early, reused: true };

    // Before prepare: a refused run reads no live card env and writes nothing.
    this.checkProductionConfirmation(input);

    const prepared = await this.prepare(input, options, requestHash);

    // A parallel call with the same key can finish prepare() first.
    const late = this.checkExisting(input.idempotency_key, requestHash);
    if (late) return { record: late, reused: true };

    if (this.queue.length >= this.deps.config.max_queued_runs) {
      throw new ToolError({
        code: 'QUEUE_FULL',
        message: `${this.queue.length} runs are waiting. The server does not accept more now.`,
        likelyCause: 'Too many runs started in a short time.',
        retryable: true,
        nextActions: [
          {
            kind: 'wait_and_retry',
            description: 'Wait for queued runs to finish, then call again with the same arguments.',
            after_s: 60,
          },
        ],
      });
    }

    // Synchronous reservation: no await between the key check above and this call.
    const persisted = this.deps.store.reserve(prepared.record);
    this.queue.push(prepared);
    await persisted;
    this.pump();
    return { record: prepared.record, reused: false };
  }

  /** Waits for all running and queued runs. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0 || this.queue.length > 0) {
      await Promise.all([...this.active]);
      await new Promise((r) => setImmediate(r));
    }
    await this.deps.store.flush();
  }

  private checkExisting(key: string, requestHash: string): RunRecord | undefined {
    const existing = this.deps.store.getKey(key);
    if (!existing) return undefined;
    if (existing.request_hash !== requestHash) {
      throw new ToolError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency_key "${key}" already belongs to run ${existing.run_id} with different arguments.`,
        likelyCause: 'The same key was used for a different target, scenario, params, or options.',
        nextActions: [
          {
            kind: 'change_argument',
            description:
              'Use a new idempotency_key for a new run, or send the original arguments to get the existing run.',
          },
          {
            kind: 'call_tool',
            description: 'Get the result of the existing run.',
            tool: 'get_run_result',
            arguments: { run_id: existing.run_id, wait_s: 20 },
          },
        ],
        details: { existing_run_id: existing.run_id },
      });
    }
    return this.get(existing.run_id);
  }

  /** An unknown target goes on to prepare, which gives UNKNOWN_TARGET. */
  private checkProductionConfirmation(input: StartRunInput): void {
    const target = Object.hasOwn(this.deps.config.targets, input.target)
      ? this.deps.config.targets[input.target]
      : undefined;
    if (!target || !isProductionTarget(target) || input.confirm_production === true) return;
    throw new ToolError({
      code: 'PRODUCTION_CONFIRMATION_REQUIRED',
      message: `Target "${input.target}" is a production target. No run started. ${PRODUCTION_WARNING}`,
      likelyCause:
        'A new run on a production target needs confirm_production: true. Set it only after the user says yes to this run.',
      retryable: false,
      nextActions: [
        {
          kind: 'ask_human',
          description: `Show the user the warning and ask: may I run "${input.scenario_id}" on the production target "${input.target}" now?`,
        },
        {
          kind: 'change_argument',
          description: `After the user agrees, call run_scenario for target "${input.target}" and scenario "${input.scenario_id}" with confirm_production: true.`,
          tool: 'run_scenario',
          arguments: { confirm_production: true },
        },
      ],
      details: { target: input.target, environment: 'production' },
    });
  }

  private checkArgumentSafety(input: StartRunInput): void {
    const argText = JSON.stringify([input.params, input.idempotency_key, input.target, input.scenario_id]);
    if (containsCardNumber(argText)) {
      const param = Object.entries(input.params).find(([, v]) => containsCardNumber(String(v)))?.[0];
      throw new ToolError({
        code: 'REAL_CARD_DATA_REFUSED',
        message: `${param ? `Param "${param}"` : 'An argument'} contains a value that looks like a payment card number. The server does not accept card numbers in arguments.`,
        likelyCause:
          'A card number was passed directly. Only test card ids from list_scenarios are accepted.',
        nextActions: [
          {
            kind: 'call_tool',
            description: 'Get the valid test card ids and use one in the test_card param.',
            tool: 'list_scenarios',
            arguments: { scenario_id: input.scenario_id },
          },
        ],
        ...(param ? { details: { param } } : {}),
      });
    }
    const knownSecrets = new Set<string>();
    for (const t of Object.values(this.deps.config.targets)) {
      for (const envName of Object.values(t.secrets)) {
        const v = this.env[envName];
        if (v && v.length >= 4) knownSecrets.add(v);
      }
    }
    const values = [input.idempotency_key, ...Object.values(input.params).map(String)];
    if (
      values.some(
        (v) => looksLikeSecret(v) || knownSecrets.has(v) || [...knownSecrets].some((s) => v.includes(s)),
      )
    ) {
      throw new ToolError({
        code: 'SECRET_IN_ARGUMENTS',
        message:
          'An argument looks like a secret (password, token, or API key). Secrets are not accepted in tool arguments.',
        likelyCause:
          'A credential was passed in params. Scenarios read secrets from environment variables named in the server config.',
        nextActions: [
          {
            kind: 'ask_human',
            description:
              'Ask a human to put the secret in an environment variable and map it in the target "secrets" config.',
          },
        ],
      });
    }
  }

  private async prepare(input: StartRunInput, options: RunOptions, requestHash: string): Promise<Prepared> {
    const { config, registry } = this.deps;
    const targetNames = Object.keys(config.targets);
    const target = config.targets[input.target];
    if (!target) {
      const suggestion = closest(input.target, targetNames);
      throw new ToolError({
        code: 'UNKNOWN_TARGET',
        message: `Target "${input.target}" is not in the server config.`,
        likelyCause: `${suggestion ? 'Typo in the target name. ' : ''}Configured targets: ${targetNames.join(', ')}. Targets are names, not URLs.`,
        nextActions: [
          suggestion
            ? {
                kind: 'change_argument',
                description: `Call run_scenario again with target "${suggestion}".`,
                tool: 'run_scenario',
                arguments: { target: suggestion },
              }
            : {
                kind: 'call_tool',
                description: 'List the configured targets.',
                tool: 'list_scenarios',
                arguments: {},
              },
        ],
        details: { configured_targets: targetNames, ...(suggestion ? { closest_match: suggestion } : {}) },
      });
    }

    const loaded = registry.get(input.scenario_id);
    if (!loaded) {
      const suggestion = closest(input.scenario_id, registry.ids());
      throw new ToolError({
        code: 'UNKNOWN_SCENARIO',
        message: `Scenario "${input.scenario_id}" does not exist.`,
        likelyCause: suggestion
          ? `Typo in the scenario id. Closest match: "${suggestion}".`
          : 'The id is not one of the loaded scenarios.',
        nextActions: [
          suggestion
            ? {
                kind: 'change_argument',
                description: `Call run_scenario again with scenario_id "${suggestion}".`,
                tool: 'run_scenario',
                arguments: { scenario_id: suggestion },
              }
            : {
                kind: 'call_tool',
                description: 'List the available scenarios.',
                tool: 'list_scenarios',
                arguments: {},
              },
        ],
        details: { available: registry.ids() },
      });
    }
    const scenario = loaded.scenario;

    if (!scenario.compatible_profiles.includes(target.profile)) {
      const compatible = targetNames.filter((n) =>
        scenario.compatible_profiles.includes(config.targets[n]?.profile ?? ''),
      );
      throw new ToolError({
        code: 'SCENARIO_NOT_COMPATIBLE',
        message: `Scenario "${scenario.id}" does not run on target "${input.target}" (profile "${target.profile}").`,
        likelyCause: `The scenario selectors are written for profiles: ${scenario.compatible_profiles.join(', ')}.`,
        nextActions: [
          compatible.length
            ? {
                kind: 'change_argument',
                description: `Use one of these targets: ${compatible.join(', ')}.`,
                tool: 'run_scenario',
                arguments: { target: compatible[0] },
              }
            : {
                kind: 'call_tool',
                description: 'Find a scenario for this target.',
                tool: 'list_scenarios',
                arguments: { target: input.target },
              },
        ],
        details: { compatible_targets: compatible },
      });
    }

    const production = isProductionTarget(target);
    if (production && options.trace) {
      throw new ToolError({
        code: 'INVALID_PARAMS',
        message: `Target "${input.target}" is a production target. A trace is not allowed on it.`,
        likelyCause: 'A trace holds DOM snapshots with typed values, such as card data and addresses.',
        nextActions: [
          {
            kind: 'change_argument',
            description: 'Call run_scenario again with options.trace set to false.',
            tool: 'run_scenario',
            arguments: { options: { trace: false } },
          },
        ],
        details: { option: 'trace' },
      });
    }

    // Placeholders only. The env values are read below, and only for the live cards that the params name.
    const liveCards = production ? liveCardPlaceholders(target) : undefined;
    const params = resolveParams(scenario, input.params, liveCards);
    const redactor = new Redactor();
    const missing: string[] = [];
    const invalidLive: string[] = [];
    const allowedCardNumbers = new Set<string>();
    for (const [param, card] of Object.entries(params.cards)) {
      if (!card.id.startsWith(LIVE_CARD_PREFIX)) continue;
      const entry = target.live_cards[card.id.slice(LIVE_CARD_PREFIX.length)];
      if (!entry) continue;
      const read = (envName: string) => {
        const value = this.env[envName];
        if (!value) missing.push(`${card.id} (env ${envName})`);
        return value ?? '';
      };
      const number = read(entry.number_env);
      const expiry = read(entry.expiry_env);
      const cvc = read(entry.cvc_env);
      if (number && !(/^\d{13,19}$/.test(number) && luhnValid(number))) {
        invalidLive.push(`${card.id} (env ${entry.number_env})`);
      }
      if (number) allowedCardNumbers.add(number);
      params.cards[param] = { ...card, number, expiry, cvc };
    }
    if (invalidLive.length > 0) {
      throw new ToolError({
        code: 'MISSING_ENV_SECRET',
        message: `The live card env value is not a valid card number: ${invalidLive.join(', ')}.`,
        likelyCause:
          'The environment variable does not hold 13 to 19 digits with a valid Luhn check. Spaces and dashes are not allowed.',
        nextActions: [
          {
            kind: 'ask_human',
            description:
              'Ask a human to check the live card environment variable and restart the MCP server.',
          },
        ],
        details: { invalid: invalidLive },
      });
    }

    // Secrets referenced by the scenario and by http_credentials.
    // Steps and outcome checks whose "when" conditions pass for these params. Only they run.
    const activeSteps = scenario.steps.filter((st) => conditionsPass(st.when, params.values));
    const activeOutcome = scenario.outcome.filter((o) => conditionsPass(o.when, params.values));
    if (activeSteps.length === 0) {
      throw new ToolError({
        code: 'INVALID_PARAMS',
        message: `Scenario "${scenario.id}" has no steps to run for these params.`,
        likelyCause: 'The "when" conditions of every step exclude the given param values.',
        nextActions: [
          {
            kind: 'call_tool',
            description: 'Check the param values for this scenario.',
            tool: 'list_scenarios',
            arguments: { scenario_id: scenario.id },
          },
        ],
      });
    }
    const tokens = collectTokens([activeSteps, activeOutcome]);
    const secretNames = new Set(
      [...tokens].filter((t) => t.startsWith('secrets.')).map((t) => t.slice('secrets.'.length)),
    );
    if (target.http_credentials) {
      secretNames.add(target.http_credentials.username_secret);
      secretNames.add(target.http_credentials.password_secret);
    }
    const secrets: Record<string, string> = {};
    for (const name of secretNames) {
      const envName = target.secrets[name];
      const value = envName ? this.env[envName] : undefined;
      if (!envName || !value)
        missing.push(
          envName ? `${name} (env ${envName})` : `${name} (not mapped in target "${input.target}")`,
        );
      else {
        secrets[name] = value;
        redactor.register(value);
      }
    }
    if (missing.length > 0) {
      throw new ToolError({
        code: 'MISSING_ENV_SECRET',
        message: `Secrets are missing for this run: ${missing.join(', ')}.`,
        likelyCause:
          'An environment variable is not set for the MCP server process, or the target config has no mapping.',
        nextActions: [
          {
            kind: 'ask_human',
            description: 'Ask a human to set the environment variables and restart the MCP server.',
          },
        ],
        details: { missing },
      });
    }

    const data = await this.loadData(scenario.data, scenario.id);
    const cardList = Object.values(params.cards);
    // A page can show the number in groups. The short expiry forms and a standalone CVC also match
    // order numbers and dates, so only a live card gets them.
    for (const c of cardList) {
      const live = c.id.startsWith(LIVE_CARD_PREFIX);
      redactor.registerCardNumber(c.number);
      if (live) redactor.registerExpiry(c.expiry);
      else redactor.register(c.expiry);
      redactor.registerCvc(c.cvc, { everywhere: live });
    }
    const ctx = {
      params: params.values,
      data,
      cards: params.cards,
      ...(cardList.length === 1 ? { card: cardList[0] } : {}),
      secrets,
      // Only steps that run can capture. A token for a capture in a skipped step stops the run here.
      captured: capturedPlaceholders(activeSteps.flatMap((st) => (st.capture ?? []).map((c) => c.name))),
    };

    let steps: Step[];
    let outcome: OutcomeCheck[];
    try {
      steps = renderDeep(activeSteps, ctx);
      outcome = renderDeep(activeOutcome, ctx);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      throw new ToolError({
        code: 'INVALID_PARAMS',
        message: `Scenario "${scenario.id}" cannot be prepared: ${err.message}`,
        likelyCause: 'The scenario YAML refers to a param, data field, or card that does not exist.',
        nextActions: [{ kind: 'fix_scenario', description: `Fix the template token in ${loaded.file}.` }],
      });
    }

    const httpCredentials = target.http_credentials
      ? {
          username: secrets[target.http_credentials.username_secret] ?? '',
          password: secrets[target.http_credentials.password_secret] ?? '',
        }
      : undefined;

    const runId = newRunId();
    const record: RunRecord = {
      run_id: runId,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      scenario_id: scenario.id,
      scenario_hash: loaded.hash,
      target: input.target,
      params: params.values,
      options,
      status: 'queued',
      verdict: null,
      summary: '',
      created_at: this.now().toISOString(),
      started_at: null,
      finished_at: null,
      duration_ms: null,
      progress: { completed_steps: 0, total_steps: activeSteps.length, current_step_id: null },
      failure: null,
      outcome_checks: activeOutcome.map((o) => ({ id: o.id, status: 'not_run' })),
      steps: activeSteps.map((s) => ({ id: s.id, title: s.title, status: 'pending' })),
      console_errors: [],
      network_failures: [],
      blocked_requests: [],
      artifacts: { run_dir: this.deps.store.runDir(runId), screenshots: [], trace_path: null },
    };
    record.summary = buildSummary(record);
    return { record, loaded, target, steps, outcome, redactor, allowedCardNumbers, httpCredentials };
  }

  private async loadData(refs: Record<string, string>, scenarioId: string): Promise<Record<string, unknown>> {
    const root = this.deps.config.test_data_dir;
    const out: Record<string, unknown> = {};
    for (const [name, rel] of Object.entries(refs)) {
      const file = path.resolve(root, rel);
      const fail = (why: string) =>
        new ToolError({
          code: 'INVALID_PARAMS',
          message: `Scenario "${scenarioId}" cannot load test data "${name}" (${rel}): ${why}`,
          likelyCause: 'The test data file is missing, outside test_data_dir, or invalid.',
          nextActions: [
            {
              kind: 'ask_human',
              description: 'Ask a human to check test_data_dir and the scenario "data" section.',
            },
          ],
        });
      if (!file.startsWith(root + path.sep)) throw fail('the path is outside test_data_dir.');
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        throw fail('the file does not exist.');
      }
      if (containsCardNumber(text)) throw fail('the file contains a card number.');
      out[name] = parse(text);
    }
    return out;
  }

  private pump(): void {
    while (this.queue.length > 0 && this.slots.tryAcquire()) {
      const next = this.queue.shift() as Prepared;
      const p = this.runOne(next).finally(() => {
        this.active.delete(p);
        // release() calls pump() through onFree when no inspection waits for the slot.
        this.slots.release();
      });
      this.active.add(p);
    }
  }

  private async runOne(p: Prepared): Promise<void> {
    const { store, logger } = this.deps;
    const startedAt = this.now();
    let record: RunRecord = { ...p.record, status: 'running', started_at: startedAt.toISOString() };
    record.summary = buildSummary(record);
    await store.save(record);
    this.events.emit(record.run_id);
    logger.info('run started', {
      run_id: record.run_id,
      scenario: record.scenario_id,
      target: record.target,
    });

    try {
      const out = await this.execute({
        runDir: store.runDir(record.run_id),
        scenario: p.loaded.scenario,
        steps: p.steps,
        outcome: p.outcome,
        target: p.target,
        targetName: record.target,
        config: this.deps.config,
        options: record.options,
        ...(p.httpCredentials ? { httpCredentials: p.httpCredentials } : {}),
        redactor: p.redactor,
        allowedCardNumbers: p.allowedCardNumbers,
        onProgress: (prog) => {
          record = {
            ...record,
            progress: {
              ...record.progress,
              completed_steps: prog.completed_steps,
              current_step_id: prog.current_step_id,
            },
            steps: prog.steps.map((s) => ({ ...s })),
          };
          record.summary = buildSummary(record);
          void store.save(record);
          this.events.emit(record.run_id);
        },
      });
      const finishedAt = this.now();
      record = {
        ...record,
        status: 'finished',
        verdict: out.verdict,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        progress: {
          ...record.progress,
          completed_steps: out.steps.filter((s) => s.status === 'passed').length,
          current_step_id: null,
        },
        failure: out.failure,
        outcome_checks: out.outcome_checks,
        steps: out.steps,
        console_errors: out.console_errors,
        network_failures: out.network_failures,
        blocked_requests: out.blocked_requests,
        artifacts: {
          run_dir: store.runDir(record.run_id),
          screenshots: out.screenshots,
          trace_path: out.trace_path,
        },
      };
    } catch (err) {
      logger.error('run crashed', {
        run_id: record.run_id,
        error: p.redactor.redact((err as Error).message ?? String(err)),
      });
      const finishedAt = this.now();
      record = {
        ...record,
        status: 'finished',
        verdict: 'error',
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        failure: {
          step_id: record.progress.current_step_id ?? 'setup',
          step_title: 'Runner',
          category: 'browser_error',
          message: p.redactor.redact((err as Error).message ?? String(err)).slice(0, 400),
          likely_causes: [
            'The test runner had an internal error. This is usually not a problem with the site.',
          ],
          next_actions: [
            {
              kind: 'wait_and_retry',
              description: 'Run the scenario again with a new idempotency_key.',
              after_s: 10,
            },
          ],
        },
      };
    }
    record.summary = buildSummary(record);
    await store.save(record);
    this.events.emit(record.run_id);
    logger.info('run finished', { run_id: record.run_id, verdict: record.verdict });
  }
}

/** Same key order for the same params. save_scenario uses it for its validation key too. */
export function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

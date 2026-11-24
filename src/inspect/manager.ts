import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../errors/tool-error.js';
import type { Logger } from '../logger.js';
import { type GuardedContext, type GuardedContextInput, openGuardedContext } from '../runner/browser.js';
import { BrowserSlots } from '../runs/browser-slots.js';
import { checkTargetHost, hostOf, isUrlAllowed } from '../safety/hosts.js';
import { redactText } from '../safety/redact-text.js';
import { InspectConfig, type ResolvedConfig, type TargetConfig } from '../schemas/config.js';
import { closest } from '../util/closest.js';
import { type CodeReport, type ScanOptions, scanSource } from './code-scan.js';
import { BlockedHostCounter, type CrawlContext, crawlSite, type SiteReport } from './crawl.js';
import { type ProbeContext, type ProbeResult, probeCheckout } from './probe.js';
import { INSPECTION_ID_PATTERN, InspectionRecord, InspectionReport, type InspectionScope } from './report.js';
import { suggestScenarios } from './suggest.js';

/** The browser and scan functions. Tests replace them, so no browser starts. */
export interface InspectionPhases {
  openContext(input: GuardedContextInput): Promise<GuardedContext>;
  crawl(ctx: CrawlContext): Promise<SiteReport>;
  probe(ctx: ProbeContext): Promise<ProbeResult>;
  scan(dirs: string[], opts: ScanOptions): Promise<CodeReport>;
}

export interface InspectionManagerDeps {
  config: ResolvedConfig;
  logger: Logger;
  /** Shared with RunManager. Default: a new set of max_parallel_runs slots. */
  slots?: BrowserSlots;
  phases?: Partial<InspectionPhases>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface StartInspectionInput {
  target: string;
  idempotency_key: string;
  scope: InspectionScope;
}

interface IdempotencyEntry {
  inspection_id: string;
  request_hash: string;
  created_at: string;
}

/** The crawl and the probe together stop after this time. The crawl returns what it has. */
const SITE_PHASE_MS = 10 * 60_000;

export const PROBE_SIDE_EFFECTS =
  'a cart item, a guest account with an example.test email, an address, and possibly an unpaid order draft';

export function newInspectionId(): string {
  return `insp_${randomBytes(12).toString('base64url')}`;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * A short error text for a report warning. It has the error class and a redacted message
 * without URLs or absolute paths, because both can hold private data.
 */
export function describeError(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name || err.name : 'Error';
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = (raw.split('\n')[0] ?? '').trim();
  const msg = redactText(
    firstLine
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
      .replace(/(^|[\s'"(=:])(?:~|[A-Za-z]:)?[\\/][^\s'")]+/g, '$1<path>'),
  ).slice(0, 200);
  return msg ? `${name}: ${msg}` : name;
}

/**
 * Inspection jobs. One inspection runs at a time, and each one waits for a browser slot
 * that it shares with the runs. Records live in runs_dir/inspections, so the same
 * idempotency key gives the same inspection, also after a restart.
 */
export class InspectionManager {
  private readonly events = new EventEmitter();
  private readonly records = new Map<string, InspectionRecord>();
  private readonly keys = new Map<string, IdempotencyEntry>();
  private readonly phases: InspectionPhases;
  private readonly slots: BrowserSlots;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private writeChain: Promise<void> = Promise.resolve();
  /** Jobs run one after another on this chain. */
  private jobChain: Promise<void> = Promise.resolve();
  private initDone: Promise<void> | undefined;

  constructor(private readonly deps: InspectionManagerDeps) {
    this.phases = {
      openContext: openGuardedContext,
      crawl: crawlSite,
      probe: probeCheckout,
      scan: scanSource,
      ...deps.phases,
    };
    this.slots = deps.slots ?? new BrowserSlots(deps.config.max_parallel_runs);
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.events.setMaxListeners(0);
  }

  get dir(): string {
    return path.join(this.deps.config.runs_dir, 'inspections');
  }

  reportPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private indexFile(): string {
    return path.join(this.dir, 'idempotency.json');
  }

  /** Loads the records. An inspection that was running when the server stopped becomes finished and interrupted. */
  init(): Promise<void> {
    this.initDone ??= this.load();
    return this.initDone;
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexFile(), 'utf8')) as Record<string, IdempotencyEntry>;
      for (const [k, v] of Object.entries(raw)) this.keys.set(k, v);
    } catch {
      // No index yet.
    }
    let rebuilt = false;
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      const id = entry.name.replace(/\.json$/, '');
      if (!entry.isFile() || !INSPECTION_ID_PATTERN.test(id)) continue;
      try {
        const parsed = InspectionRecord.safeParse(JSON.parse(await readFile(this.reportPath(id), 'utf8')));
        if (!parsed.success) continue;
        let record = parsed.data;
        if (record.status !== 'finished') {
          record = {
            ...record,
            status: 'finished',
            interrupted: true,
            progress: 'Interrupted: the server stopped during this inspection.',
            finished_at: this.now().toISOString(),
            warnings: [
              ...record.warnings,
              'The server stopped during this inspection. The inspection was not repeated. The report has only the parts that were done. Use a new idempotency_key to inspect again.',
            ],
          };
          this.deps.logger.warn('inspection interrupted', { inspection_id: record.inspection_id });
          void this.save(record);
        }
        this.records.set(record.inspection_id, record);
        // The server can stop between the record write and the index write. The record has the key too.
        if (!this.keys.has(record.idempotency_key)) {
          this.keys.set(record.idempotency_key, {
            inspection_id: record.inspection_id,
            request_hash: record.request_hash,
            created_at: record.created_at,
          });
          rebuilt = true;
        }
      } catch {
        // A broken file. Ignore it.
      }
    }
    if (rebuilt) {
      const index = Object.fromEntries(this.keys);
      const fn = () => writeJsonAtomic(this.indexFile(), index);
      const next = this.writeChain.then(fn, fn);
      this.writeChain = next.catch(() => {});
    }
    await this.writeChain;
  }

  async start(input: StartInspectionInput): Promise<{ report: InspectionReport; reused: boolean }> {
    await this.init();
    const target = this.checkTarget(input);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ t: input.target, s: input.scope }))
      .digest('hex')
      .slice(0, 32);
    const existing = this.checkExisting(input, requestHash);
    if (existing) return { report: this.toReport(existing), reused: true };
    const httpCredentials = this.httpCredentials(input.target, target);

    const id = newInspectionId();
    const record: InspectionRecord = {
      inspection_id: id,
      target: input.target,
      status: 'queued',
      interrupted: false,
      progress: 'Queued. The inspection waits for a free browser.',
      site: null,
      checkout_probe: null,
      code: null,
      suggested_scenarios: [],
      warnings: [],
      side_effects: [],
      report_path: this.reportPath(id),
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      scope: input.scope,
      created_at: this.now().toISOString(),
      finished_at: null,
    };
    // Synchronous reservation: no await between the key check and these lines.
    this.keys.set(input.idempotency_key, {
      inspection_id: id,
      request_hash: requestHash,
      created_at: record.created_at,
    });
    this.records.set(id, record);
    const persisted = this.save(record, true);
    const job = () =>
      this.runJob(id, target, httpCredentials).catch((err: unknown) => this.jobCrashed(id, err));
    // A failed job never stops the jobs after it.
    this.jobChain = this.jobChain.then(job, job);
    await persisted;
    return { report: this.toReport(record), reused: false };
  }

  get(id: string): InspectionReport {
    const r = this.records.get(id);
    if (!r) throw new Error(`Inspection ${id} does not exist.`);
    return this.toReport(r);
  }

  /** True when the key already belongs to an inspection, also after a restart. */
  async hasKey(key: string): Promise<boolean> {
    await this.init();
    return this.keys.has(key);
  }

  /**
   * The newest finished inspection of a target that read the site and that the server did not interrupt.
   * An inspection whose probe reached the payment step wins over a newer one whose probe did not.
   * The create_scenario prompt gives its key to the agent, so a second call reads it again and starts no probe.
   */
  async latestFinished(
    target: string,
  ): Promise<{ idempotency_key: string; scope: InspectionScope } | undefined> {
    await this.init();
    let best: InspectionRecord | undefined;
    for (const r of this.records.values()) {
      if (r.target !== target || r.scope === 'code' || r.status !== 'finished' || r.interrupted) continue;
      if (!r.finished_at) continue;
      if (!best) {
        best = r;
        continue;
      }
      // A report that reached the payment step has the most facts. It wins over a newer one without.
      const paid = (x: InspectionRecord) => (x.checkout_probe?.reached === 'payment' ? 1 : 0);
      if (paid(r) > paid(best) || (paid(r) === paid(best) && (best.finished_at ?? '') < r.finished_at))
        best = r;
    }
    return best ? { idempotency_key: best.idempotency_key, scope: best.scope } : undefined;
  }

  /** Resolves when the inspection is finished, or after wait_s seconds. Progress changes do not end the wait. */
  async wait(id: string, waitS: number): Promise<InspectionReport> {
    const deadline = Date.now() + waitS * 1000;
    let current = this.get(id);
    while (current.status !== 'finished' && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.events.off(id, done);
          resolve();
        };
        const timer = setTimeout(done, deadline - Date.now());
        this.events.on(id, done);
      });
      current = this.get(id);
    }
    return current;
  }

  /** Waits for all queued and running inspections and their writes. For tests and shutdown. */
  async idle(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.jobChain;
      await chain;
    } while (chain !== this.jobChain);
    await this.writeChain;
  }

  private toReport(r: InspectionRecord): InspectionReport {
    return InspectionReport.parse(r);
  }

  private checkTarget(input: StartInspectionInput): TargetConfig {
    const { config } = this.deps;
    const names = Object.keys(config.targets);
    const target = config.targets[input.target];
    if (!target) {
      const suggestion = closest(input.target, names);
      throw new ToolError({
        code: 'UNKNOWN_TARGET',
        message: `Target "${input.target}" is not in the server config.`,
        likelyCause: `${suggestion ? 'Typo in the target name. ' : ''}Configured targets: ${names.join(', ')}. Targets are names, not URLs.`,
        nextActions: [
          suggestion
            ? {
                kind: 'change_argument',
                description: `Call inspect_target again with target "${suggestion}".`,
                tool: 'inspect_target',
                arguments: { target: suggestion },
              }
            : {
                kind: 'call_tool',
                description: 'List the configured targets.',
                tool: 'list_scenarios',
                arguments: {},
              },
        ],
        details: { configured_targets: names, ...(suggestion ? { closest_match: suggestion } : {}) },
      });
    }
    // The config load refuses these targets too. This check keeps the inspection safe on its own.
    for (const host of new Set([hostOf(target.base_url), ...target.allowed_hosts])) {
      const check = checkTargetHost(host, target, config);
      if (check.ok) continue;
      throw new ToolError({
        code: check.reason === 'production' ? 'PRODUCTION_HOST_REFUSED' : 'HOST_NOT_ALLOWED',
        message:
          check.reason === 'production'
            ? `Target "${input.target}" has a host that is in production_hosts. The server does not inspect it.`
            : `Target "${input.target}" has a host that does not look like a test environment.`,
        likelyCause: 'The target config points at a production site, or the host has no test label.',
        nextActions: [
          {
            kind: 'ask_human',
            description: 'Ask a human to point the target at a test environment in the server config.',
          },
        ],
        details: { host },
      });
    }
    const inspect = target.inspect;
    if (input.scope === 'code' && (inspect?.source_dirs.length ?? 0) === 0) {
      throw new ToolError({
        code: 'INVALID_PARAMS',
        message: `scope "code" needs source folders, but target "${input.target}" has no inspect.source_dirs.`,
        likelyCause: 'The target config has no source folders for the code scan.',
        nextActions: [
          {
            kind: 'change_argument',
            description: 'Call inspect_target with scope "site" to read the site only.',
            tool: 'inspect_target',
            arguments: { scope: 'site' },
          },
          {
            kind: 'ask_human',
            description: `Ask a human to add the shop source folders to targets.${input.target}.inspect.source_dirs.`,
          },
        ],
      });
    }
    return target;
  }

  private checkExisting(input: StartInspectionInput, requestHash: string): InspectionRecord | undefined {
    const entry = this.keys.get(input.idempotency_key);
    if (!entry) return undefined;
    const record = this.records.get(entry.inspection_id);
    if (entry.request_hash !== requestHash || !record) {
      throw new ToolError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency_key "${input.idempotency_key}" already belongs to inspection ${entry.inspection_id} with different arguments.`,
        likelyCause: 'The same key was used for a different target or scope.',
        nextActions: [
          {
            kind: 'change_argument',
            description:
              'Use a new idempotency_key for a new inspection, or send the original arguments to get the existing inspection.',
          },
          ...(record
            ? [
                {
                  kind: 'call_tool' as const,
                  description: 'Get the existing inspection.',
                  tool: 'inspect_target',
                  arguments: {
                    target: record.target,
                    idempotency_key: input.idempotency_key,
                    scope: record.scope,
                    wait_s: 20,
                  },
                },
              ]
            : []),
        ],
        details: { existing_inspection_id: entry.inspection_id },
      });
    }
    return record;
  }

  private httpCredentials(
    name: string,
    target: TargetConfig,
  ): { username: string; password: string } | undefined {
    const creds = target.http_credentials;
    if (!creds) return undefined;
    const missing: string[] = [];
    const read = (secret: string): string => {
      const envName = target.secrets[secret];
      const value = envName ? this.env[envName] : undefined;
      if (!value) missing.push(envName ? `${secret} (env ${envName})` : `${secret} (not mapped)`);
      return value ?? '';
    };
    const out = { username: read(creds.username_secret), password: read(creds.password_secret) };
    if (missing.length > 0) {
      throw new ToolError({
        code: 'MISSING_ENV_SECRET',
        message: `Secrets are missing for target "${name}": ${missing.join(', ')}.`,
        likelyCause: 'An environment variable for http_credentials is not set for the MCP server process.',
        nextActions: [
          {
            kind: 'ask_human',
            description: 'Ask a human to set the environment variables and restart the MCP server.',
          },
        ],
        details: { missing },
      });
    }
    return out;
  }

  private save(record: InspectionRecord, withIndex = false): Promise<void> {
    this.records.set(record.inspection_id, record);
    const snapshot = structuredClone(record);
    const index = withIndex ? Object.fromEntries(this.keys) : undefined;
    const fn = async () => {
      await mkdir(this.dir, { recursive: true });
      await writeJsonAtomic(this.reportPath(snapshot.inspection_id), snapshot);
      if (index) await writeJsonAtomic(this.indexFile(), index);
    };
    // Writes go one after another, so an older snapshot never overwrites a newer one.
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch((err: unknown) => {
      this.deps.logger.error('inspection write failed', { error: describeError(err) });
    });
    return next;
  }

  private update(id: string, change: Partial<InspectionRecord>): InspectionRecord {
    const current = this.records.get(id);
    if (!current) throw new Error(`Inspection ${id} does not exist.`);
    const next = { ...current, ...change };
    void this.save(next);
    this.events.emit(id);
    return next;
  }

  /** The last update. A waiter wakes after the file is on disk, so report_path has the final report. */
  private async finish(id: string, change: Partial<InspectionRecord>): Promise<void> {
    const current = this.records.get(id);
    if (!current) return;
    await this.save({ ...current, ...change, status: 'finished' }).catch(() => {});
    this.events.emit(id);
  }

  /** A job that failed outside its phases, for example while it waited for a slot. It finishes, so a poll ends. */
  private async jobCrashed(id: string, err: unknown): Promise<void> {
    const text = describeError(err);
    this.deps.logger.error('inspection job failed', { inspection_id: id, error: text });
    const current = this.records.get(id);
    if (!current || current.status === 'finished') return;
    await this.finish(id, {
      progress: 'Finished with an error.',
      finished_at: this.now().toISOString(),
      warnings: [
        ...current.warnings,
        `INSPECTION_FAILED: the inspection stopped with ${text}. Use a new idempotency_key to try again.`,
      ],
    });
  }

  private async runJob(
    id: string,
    target: TargetConfig,
    httpCredentials: { username: string; password: string } | undefined,
  ): Promise<void> {
    const { logger } = this.deps;
    const initial = this.records.get(id);
    if (!initial) return;
    const name = initial.target;
    const scope = initial.scope;
    const inspect = target.inspect ?? InspectConfig.parse({});
    const warnings: string[] = [];
    const fail = (phase: string, err: unknown) => {
      const text = describeError(err);
      warnings.push(
        `INSPECTION_FAILED: the ${phase} stopped with ${text}. The report keeps the parts that were done.`,
      );
      logger.error('inspection phase failed', { inspection_id: id, phase, error: text });
    };
    let site: SiteReport | null = null;
    let probe: ProbeResult | null = null;
    let code: CodeReport | null = null;

    await this.slots.acquire();
    try {
      this.update(id, { status: 'running', progress: 'Started.' });
      logger.info('inspection started', { inspection_id: id, target: name, scope });
      const progress = (msg: string) => this.update(id, { progress: redactText(msg).slice(0, 300) });

      if (scope !== 'code') {
        const signal = AbortSignal.timeout(SITE_PHASE_MS);
        const blocked = new BlockedHostCounter();
        let guarded: GuardedContext | undefined;
        try {
          guarded = await this.phases.openContext({
            config: this.deps.config,
            target,
            ...(httpCredentials ? { httpCredentials } : {}),
            onBlocked: blocked.onBlocked,
          });
        } catch (err) {
          fail('browser start', err);
        }
        if (guarded) {
          try {
            try {
              progress('Reading the site.');
              site = await this.phases.crawl({
                context: guarded.context,
                target,
                inspect,
                config: this.deps.config,
                blocked,
                signal,
                onProgress: progress,
              });
              this.update(id, { site });
            } catch (err) {
              fail('site crawl', err);
            }
            if (inspect.probe_checkout) {
              try {
                progress('Probing the checkout up to the payment step.');
                probe = await this.phases.probe({
                  context: guarded.context,
                  target,
                  inspect,
                  signal,
                  onProgress: progress,
                  ...(site ? { pages: site.pages } : {}),
                });
                this.update(id, { checkout_probe: probe });
              } catch (err) {
                fail('checkout probe', err);
              }
            }
          } finally {
            await guarded.close();
          }
          // The probe can meet hosts that the crawl did not.
          if (site) site = { ...site, blocked_hosts: blocked.list() };
        }
      }

      if (scope !== 'site' && inspect.source_dirs.length > 0) {
        try {
          progress('Reading the source code.');
          code = await this.phases.scan(inspect.source_dirs, {
            words: inspect.words,
            testIdAttribute: target.test_id_attribute,
          });
        } catch (err) {
          fail('code scan', err);
        }
      }

      warnings.push(...this.contextWarnings(name, scope, inspect, site, probe));
      const suggested = suggestScenarios({
        target: name,
        site,
        probe,
        code,
        hasMemberSecrets: 'member_email' in target.secrets && 'member_password' in target.secrets,
      });
      if (scope !== 'code' && !suggested.some((s) => s.card_source !== null)) {
        warnings.push(
          'No test card source found. Ask the user for the test cards of the payment provider, or add source_dirs so the code scan can find the payment package.',
        );
      }
      const current = this.records.get(id);
      await this.finish(id, {
        status: 'finished',
        progress: 'Finished.',
        site,
        checkout_probe: probe,
        code,
        suggested_scenarios: suggested,
        warnings: [...(current?.warnings ?? []), ...warnings],
        side_effects: probe?.side_effects ?? [],
        finished_at: this.now().toISOString(),
      });
      logger.info('inspection finished', { inspection_id: id, warnings: warnings.length });
    } catch (err) {
      // A bug outside the phases. Keep what exists and finish, so a poll never waits for ever.
      fail('inspection', err);
      const current = this.records.get(id);
      await this.finish(id, {
        status: 'finished',
        progress: 'Finished with an error.',
        site,
        checkout_probe: probe,
        code,
        warnings: [...(current?.warnings ?? []), ...warnings],
        side_effects: probe?.side_effects ?? [],
        finished_at: this.now().toISOString(),
      });
    } finally {
      this.slots.release();
    }
  }

  private contextWarnings(
    name: string,
    scope: InspectionScope,
    inspect: InspectConfig,
    site: SiteReport | null,
    probe: ProbeResult | null,
  ): string[] {
    const out: string[] = [];
    if (scope !== 'code' && !inspect.probe_checkout) {
      out.push(
        `The checkout probe did not run, because targets.${name}.inspect.probe_checkout is not true. Ask the user before you turn it on. Side effects of the probe on the test site: ${PROBE_SIDE_EFFECTS}.`,
      );
    }
    if (probe && probe.reached !== 'payment') {
      out.push(`The checkout probe stopped before the payment step: ${probe.stopped_reason}.`);
    }
    if (scope === 'both' && inspect.source_dirs.length === 0) {
      out.push(
        `The code scan did not run, because targets.${name}.inspect.source_dirs is empty. Add the shop source folders to read routes, UI strings, and payment packages.`,
      );
    }
    const target = this.deps.config.targets[name];
    const blockedCardHosts = new Set(
      (probe?.payment?.card_frames ?? [])
        .map((f) => f.host)
        .filter((h) => target && !isUrlAllowed(`https://${h}/`, target, this.deps.config)),
    );
    for (const host of blockedCardHosts) {
      out.push(
        `The card fields are unknown, because the guard blocked the card frame host ${host}. Ask the user to add ${host} to targets.${name}.third_party_hosts, restart the server, and inspect again.`,
      );
    }
    if (site && site.blocked_hosts.length > 0) {
      out.push(
        `The guard blocked ${site.blocked_hosts.length} hosts (see site.blocked_hosts). Ask the user before you add a host to third_party_hosts.`,
      );
    }
    return out;
  }
}

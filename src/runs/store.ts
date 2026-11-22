import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUN_ID_PATTERN } from '../schemas/common.js';
import { RunRecord } from '../schemas/run.js';

export interface IdempotencyEntry {
  run_id: string;
  request_hash: string;
  created_at: string;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Run records and the idempotency index on disk. One server process owns a runs_dir. */
export class RunStore {
  private readonly records = new Map<string, RunRecord>();
  private readonly keys = new Map<string, IdempotencyEntry>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly runsDir: string) {}

  /** Loads all runs. Returns runs that were not finished when the server stopped. */
  async init(): Promise<RunRecord[]> {
    await mkdir(this.runsDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexFile(), 'utf8')) as Record<string, IdempotencyEntry>;
      for (const [k, v] of Object.entries(raw)) this.keys.set(k, v);
    } catch {
      // No index yet.
    }
    const interrupted: RunRecord[] = [];
    for (const entry of await readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
      try {
        const parsed = RunRecord.safeParse(JSON.parse(await readFile(this.resultFile(entry.name), 'utf8')));
        if (!parsed.success) continue;
        this.records.set(parsed.data.run_id, parsed.data);
        if (parsed.data.status !== 'finished') interrupted.push(parsed.data);
      } catch {
        // Broken or partial run folder. Ignore it.
      }
    }
    return interrupted;
  }

  runDir(runId: string): string {
    return path.join(this.runsDir, runId);
  }

  private resultFile(runId: string): string {
    return path.join(this.runDir(runId), 'result.json');
  }

  private indexFile(): string {
    return path.join(this.runsDir, 'idempotency.json');
  }

  getKey(key: string): IdempotencyEntry | undefined {
    return this.keys.get(key);
  }

  get(runId: string): RunRecord | undefined {
    return this.records.get(runId);
  }

  /**
   * Reserves the key and stores the record in memory at once (synchronous),
   * so a second call with the same key in the same tick sees the run.
   */
  reserve(record: RunRecord): Promise<void> {
    this.keys.set(record.idempotency_key, {
      run_id: record.run_id,
      request_hash: record.request_hash,
      created_at: record.created_at,
    });
    this.records.set(record.run_id, record);
    return this.enqueueWrite(async () => {
      await mkdir(this.runDir(record.run_id), { recursive: true });
      await writeJsonAtomic(this.resultFile(record.run_id), record);
      await writeJsonAtomic(this.indexFile(), Object.fromEntries(this.keys));
    });
  }

  save(record: RunRecord): Promise<void> {
    this.records.set(record.run_id, record);
    const snapshot = structuredClone(record);
    return this.enqueueWrite(async () => {
      await mkdir(this.runDir(snapshot.run_id), { recursive: true });
      await writeJsonAtomic(this.resultFile(snapshot.run_id), snapshot);
    });
  }

  /** Writes run one after another, so an older snapshot never overwrites a newer one. */
  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}

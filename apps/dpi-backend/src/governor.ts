// Session cap: limits concurrently running agent turns. The cap comes from ~/.dpi/governor.json
// ({"max_workers": N}, written by deploy/factory-governor.sh) or DPI_MAX_WORKERS, which wins.
// pi-durable 1.0.3 has no runtime worker/concurrency option, so this is an admission gate in front of
// Conversation.submit(). Held requests live in memory only: they are not submitted, so they do not
// survive a restart (the client sees the request fail and retries with the same requestId). A held request
// keeps its HTTP call open until admitted, because a submissionId only exists once submit() runs.
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CAP = 5;
const clamp = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : undefined);

/** Reads the cap, re-parsing the file only when its mtime changes. */
export function capReader(path = join(homedir(), ".dpi", "governor.json"), env: NodeJS.ProcessEnv = process.env) {
  let seen = -1;
  let cached = DEFAULT_CAP;
  return (): number => {
    const fromEnv = env.DPI_MAX_WORKERS?.trim() ? clamp(Number(env.DPI_MAX_WORKERS)) : undefined;
    if (fromEnv !== undefined) return fromEnv;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      seen = -1;
      return (cached = DEFAULT_CAP);
    }
    if (mtime === seen) return cached;
    seen = mtime;
    try {
      cached = clamp((JSON.parse(readFileSync(path, "utf8")) as { max_workers?: unknown })?.max_workers) ?? DEFAULT_CAP;
    } catch {
      cached = DEFAULT_CAP;
    }
    return cached;
  };
}

export interface Admitted {
  id: unknown;
  /** Resolves (or rejects) once the turn is terminal: done, unanswered, failed or aborted. */
  wait(): Promise<unknown>;
}

/** FIFO admission gate. A lowered cap never stops running turns; it only holds new ones. */
export class Gate {
  private active = new Set<unknown>();
  private queue: { slot: symbol; wake: () => void }[] = [];
  constructor(readonly cap: () => number) {}

  stats() {
    return { cap: this.cap(), active: this.active.size, queued: this.queue.length };
  }

  async admit<T extends Admitted>(start: () => Promise<T>): Promise<T> {
    const slot = Symbol("slot"); // reserved while submitting so a burst can't overshoot
    if (this.queue.length || this.active.size >= this.cap()) await new Promise<void>((r) => this.queue.push({ slot, wake: r }));
    else this.active.add(slot);
    let started: T;
    try {
      started = await start();
    } catch (e) {
      this.release(slot);
      throw e;
    }
    this.active.delete(slot);
    if (!this.active.has(started.id)) {
      this.active.add(started.id);
      void started.wait().catch(() => {}).finally(() => this.release(started.id));
    }
    this.drain(); // a retried requestId is already counted, so its slot frees up
    return started;
  }

  private release(id: unknown) {
    if (this.active.delete(id)) this.drain();
  }

  private drain() {
    while (this.queue.length && this.active.size < this.cap()) {
      const next = this.queue.shift()!;
      this.active.add(next.slot);
      next.wake();
    }
  }
}

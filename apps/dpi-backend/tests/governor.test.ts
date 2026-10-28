import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { capReader, Gate } from "../src/governor.js";
import { bootServer, delay, newToken, tempStore } from "./helpers.js";

test("cap: default, bad JSON, clamp, env override, live change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-gov-"));
  const file = join(dir, "governor.json");
  try {
    const env: NodeJS.ProcessEnv = {};
    const cap = capReader(file, env);
    assert.equal(cap(), 5, "missing file");
    const put = async (text: string, t: number) => {
      await writeFile(file, text);
      await utimes(file, t, t); // distinct mtimes so the cache notices
    };
    await put("{nope", 1000);
    assert.equal(cap(), 5, "bad JSON");
    await put('{"max_workers": 2}', 2000);
    assert.equal(cap(), 2);
    await put('{"max_workers": 0}', 3000);
    assert.equal(cap(), 1, "clamped to >= 1");
    await put('{"max_workers": 3.7}', 4000);
    assert.equal(cap(), 3, "integer");
    await put('{"max_workers": "7"}', 5000);
    assert.equal(cap(), 5, "non-number");
    env.DPI_MAX_WORKERS = "9";
    assert.equal(cap(), 9, "env wins");
    env.DPI_MAX_WORKERS = "-4";
    assert.equal(cap(), 1);
    delete env.DPI_MAX_WORKERS;
    await put('{"max_workers": 4}', 6000);
    assert.equal(cap(), 4, "live change");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function turn(id: number) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  return { id, wait: () => done, finish };
}

test("gate: admits up to the cap, queues FIFO, releases once, lowered cap blocks only new work", async () => {
  let cap = 2;
  const gate = new Gate(() => cap);
  const turns = [1, 2, 3, 4, 5].map(turn);
  const started: number[] = [];
  const admit = (i: number) => gate.admit(async () => (started.push(turns[i].id), turns[i]));
  const pending = [0, 1, 2, 3].map(admit);
  await delay(10);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(gate.stats(), { cap: 2, active: 2, queued: 2 });

  turns[0].finish();
  await delay(10);
  assert.deepEqual(started, [1, 2, 3], "FIFO drain");
  assert.deepEqual(gate.stats(), { cap: 2, active: 2, queued: 1 });

  cap = 1; // lowering never stops running turns
  turns[1].finish();
  await delay(10);
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(gate.stats(), { cap: 1, active: 1, queued: 1 });
  turns[2].finish();
  await delay(10);
  assert.deepEqual(started, [1, 2, 3, 4]);
  turns[3].finish();
  await Promise.all(pending);
  await delay(10);
  assert.deepEqual(gate.stats(), { cap: 1, active: 0, queued: 0 });

  // A retried requestId returns the same submission: counted once, released once.
  cap = 5;
  await gate.admit(async () => turns[4]);
  await gate.admit(async () => turns[4]);
  assert.equal(gate.stats().active, 1);
  turns[4].finish();
  await delay(10);
  assert.equal(gate.stats().active, 0);

  // A failed submit frees its slot.
  await assert.rejects(() => gate.admit(async () => Promise.reject(Error("boom"))));
  assert.equal(gate.stats().active, 0);
});

test("health: /healthz and /v1/device report cap, active and queued", async () => {
  const t = await tempStore();
  const token = newToken();
  process.env.DPI_MAX_WORKERS = "3";
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    assert.deepEqual(await (await fetch(`${server.base}/healthz`)).json(), { ok: true, cap: 3, active: 0, queued: 0 });
    const info = await (await fetch(`${server.base}/v1/device`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(info.governor, { cap: 3, active: 0, queued: 0 });
  } finally {
    delete process.env.DPI_MAX_WORKERS;
    await server.stop();
    await t.cleanup();
  }
});

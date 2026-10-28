import { test } from "node:test";
import assert from "node:assert/strict";
import { createAddons, JEV_UNAVAILABLE, jevBeforeTool } from "../src/addons.js";
import type { JevAnswer } from "../src/jev.js";

/** In-memory stand-in for api.memo (the real one persists in the session's agent.sqlite). */
function memoApi() {
  const store = new Map<string, unknown>();
  const api = {
    memo: async (key: string, ...rest: unknown[]) => {
      if (rest.length === 2) store.set(key, rest[0]);
      return store.get(key);
    },
  };
  return { api: api as never, store };
}
const bash = (command: string) => ({ name: "bash", arguments: { command } });
const ctx = {} as never;
const answers = (choice: string, confidence: number, noul: number): Record<string, JevAnswer> => ({
  effect: { type: "choice", choice, confidence, probabilities: {} },
  destructive_intent: { type: "noul", noul },
});
/** The hook from the real extension, with askJev stubbed (no network). */
function hookWith(ask: () => Promise<Record<string, JevAnswer>>) {
  const ext = createAddons({ offline: false, ask: ask as never }).all["jev-damage-control"] as unknown as {
    hooks: { handlers: { beforeTool: ReturnType<typeof jevBeforeTool> } }[];
  };
  return ext.hooks[0].handlers.beforeTool;
}

test("jev gate: an error fails closed and is not memoized", async () => {
  delete process.env.DPI_JEV_FAIL_OPEN;
  let calls = 0;
  const hook = hookWith(async () => (calls++, Promise.reject(Error("Jev HTTP 503"))));
  const { api, store } = memoApi();
  assert.deepEqual(await hook(bash("ls"), api, ctx), { block: JEV_UNAVAILABLE });
  assert.equal(store.size, 0, "failure not memoized");
  assert.deepEqual(await hook(bash("ls"), api, ctx), { block: JEV_UNAVAILABLE });
  assert.equal(calls, 2, "a retry asks Jev again");
});

test("jev gate: DPI_JEV_FAIL_OPEN=1 lets bash run when Jev fails", async () => {
  process.env.DPI_JEV_FAIL_OPEN = "1";
  try {
    const hook = hookWith(async () => Promise.reject(Error("timeout")));
    const { api, store } = memoApi();
    assert.equal(await hook(bash("ls"), api, ctx), undefined);
    assert.equal(store.size, 0);
  } finally {
    delete process.env.DPI_JEV_FAIL_OPEN;
  }
});

test("jev gate: Level 6 thresholds block, safe commands pass, verdicts are memoized", async () => {
  const run = async (a: Record<string, JevAnswer>) => {
    const { api, store } = memoApi();
    const out = await hookWith(async () => a)(bash("x"), api, ctx);
    assert.equal(store.size, 1, "verdict memoized");
    return out?.block;
  };
  assert.match((await run(answers("irreversible", 0.6, 0.1)))!, /blocked this command: irreversible \(0\.60\)/);
  assert.match((await run(answers("reversible", 0.9, 0.7)))!, /destructive intent \(0\.70\)/);
  assert.equal(await run(answers("irreversible", 0.59, 0.69)), undefined);
  assert.equal(await run(answers("read_only", 0.95, 0.02)), undefined);
  // Non-bash tools are never judged.
  assert.equal(await hookWith(async () => Promise.reject(Error("x")))({ name: "read", arguments: {} }, memoApi().api, ctx), undefined);
});

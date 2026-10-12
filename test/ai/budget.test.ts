import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeOpenAi, platform, type Platform } from "./helpers.ts";

const today = () => new Date().toISOString().slice(0, 10);
type AskResult = { status: string; mode: string; provenance: { llm: { usage: { inputTokens: number; outputTokens: number } } | null } };
type Failure = { status: number; code: string; message: string; details?: Record<string, unknown> };

let p: Platform;
let fake: ReturnType<typeof fakeOpenAi>;
beforeAll(async () => {
  p = await platform();
  fake = fakeOpenAi();
});
afterAll(() => fake.stop());

const usage = async () => (await p.store.aiUsage(p.tenant.id, today(), [{ type: "user", id: p.user.id }, { type: "tenant", id: p.tenant.id }]))[`user:${p.user.id}`]!;
const reset = async () => {
  const u = await usage();
  await p.store.addAiUsage(p.tenant.id, today(), [{ type: "user", id: p.user.id }, { type: "tenant", id: p.tenant.id }], -u.requests, -u.tokens);
};
const ask = (question = "What is BetaApp?") => p.call("POST", "/ai/ask", { question }).then((r) => ({ ok: r as AskResult }), (e) => ({ err: e as Failure }));

describe("AI budgets (ai_usage counters)", () => {
  test("sequential: the request budget admits exactly N requests, the N+1th is 429 with retryAfterSeconds and does not reach the provider", async () => {
    await reset();
    await p.setAi({ provider: "openai-compatible", model: "fake-model", endpoint: fake.url, allowedModels: ["fake-model"], budgets: { userRequestsPerDay: 2, userTokensPerDay: 1_000_000, tenantRequestsPerDay: 1000, tenantTokensPerDay: 1_000_000 } });
    const hits = fake.hits.length;
    expect("ok" in (await ask())).toBe(true);
    expect("ok" in (await ask())).toBe(true);
    const third = await ask();
    expect("err" in third && third.err.status).toBe(429);
    expect("err" in third && third.err.code).toBe("RATE_LIMITED");
    expect("err" in third && third.err.details?.budget).toEqual(["user daily requests"]);
    expect("err" in third && Number(third.err.details?.retryAfterSeconds)).toBeGreaterThan(0);
    expect(fake.hits.length - hits).toBe(2);
    expect((await usage()).requests).toBe(2);
  });

  test("concurrent: N parallel requests against a budget of N-1 consume at most N-1 (reservation is an atomic upsert, over-reservation is rolled back)", async () => {
    await reset();
    const budget = 4;
    const n = budget + 1;
    await p.setAi({ budgets: { userRequestsPerDay: budget, tenantRequestsPerDay: 1000 } });
    const hits = fake.hits.length;
    const results = await Promise.all(Array.from({ length: n }, () => ask()));
    const okCount = results.filter((r) => "ok" in r).length;
    const rejected = results.filter((r) => "err" in r) as { err: Failure }[];
    expect(okCount).toBe(budget);
    expect(rejected).toHaveLength(n - budget);
    for (const r of rejected) expect(r.err.status).toBe(429);
    expect(fake.hits.length - hits).toBe(budget);
    expect((await usage()).requests).toBe(budget);
  });

  test("concurrent at the tenant level: a tenant request budget shared by all subjects is also enforced atomically", async () => {
    await reset();
    await p.setAi({ budgets: { userRequestsPerDay: 1000, tenantRequestsPerDay: 3 } });
    const hits = fake.hits.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => ask()));
    expect(results.filter((r) => "ok" in r)).toHaveLength(3);
    expect(results.filter((r) => "err" in r && r.err.details?.budget?.toString() === "tenant daily requests")).toHaveLength(3);
    expect(fake.hits.length - hits).toBe(3);
  });

  test("tokens are metered after the answer and block the next request once the budget is reached", async () => {
    await reset();
    await p.setAi({ budgets: { userRequestsPerDay: 1000, tenantRequestsPerDay: 1000, userTokensPerDay: 200, tenantTokensPerDay: 1_000_000 } });
    const first = await ask();
    expect("ok" in first && first.ok.provenance.llm?.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect((await usage()).tokens).toBe(150);
    expect("ok" in (await ask())).toBe(true);
    expect((await usage()).tokens).toBe(300);
    const third = await ask();
    expect("err" in third && third.err.details?.budget).toEqual(["user daily tokens"]);
  });

  test("token budgets are checked before the call and charged after it: concurrent requests can overshoot the token budget, bounded by the request budget (documented limitation)", async () => {
    await reset();
    await p.setAi({ budgets: { userRequestsPerDay: 3, tenantRequestsPerDay: 1000, userTokensPerDay: 100, tenantTokensPerDay: 1_000_000 } });
    const hits = fake.hits.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => ask()));
    expect(results.filter((r) => "ok" in r)).toHaveLength(3);
    expect(fake.hits.length - hits).toBe(3);
    expect((await usage()).tokens).toBe(450);
    expect("err" in (await ask())).toBe(true);
  });

  test("a provider failure still consumes the reserved request and records zero tokens", async () => {
    await reset();
    await p.setAi({ budgets: { userRequestsPerDay: 10, tenantRequestsPerDay: 1000, userTokensPerDay: 1_000_000 } });
    const broken = fakeOpenAi(() => new Response("upstream exploded", { status: 503 }));
    try {
      await p.setAi({ endpoint: broken.url });
      const r = await ask();
      expect("ok" in r && r.ok.mode).toBe("deterministic-fallback");
      expect((await usage())).toEqual({ requests: 1, tokens: 0 });
    } finally {
      broken.stop();
      await p.setAi({ endpoint: fake.url });
    }
  });

  test("a budget of 0 refuses every request without reaching the provider", async () => {
    await reset();
    await p.setAi({ budgets: { userRequestsPerDay: 0 } });
    const hits = fake.hits.length;
    const r = await ask();
    expect("err" in r && r.err.status).toBe(429);
    expect(fake.hits.length).toBe(hits);
    expect((await usage()).requests).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { safeReturnTo } from "../../src/platform/auth.ts";
import { startPlatform, type Platform } from "./helpers.ts";

const ORIGIN = "https://vogoban.test";

const ACCEPTED: [string, string][] = [
  ["/", "/"],
  ["/dashboard", "/dashboard"],
  ["/dashboard?x=1", "/dashboard?x=1"],
  ["/a#b", "/a#b"],
  ["/a/b/c?x=1&y=2#frag", "/a/b/c?x=1&y=2#frag"],
  ["/ with space", "/%20with%20space"],
  ["/%2f%2fevil.test", "/%2f%2fevil.test"],
  ["/@evil.test", "/@evil.test"],
];

const REJECTED = [
  "https://evil.test",
  "http://evil.test/",
  "https://vogoban.test/dashboard",
  "//evil.test",
  "///evil.test",
  "/\\evil.test",
  "/\\\\evil.test",
  "\\\\evil.test",
  "\\/evil.test",
  "/\t/evil.test",
  "/\r/evil.test",
  "/\n/evil.test",
  "/\r\n/evil.test",
  "\t//evil.test",
  "\n//evil.test",
  "/\u0000/evil.test",
  "/\u001f//evil.test",
  "/\u007f//evil.test",
  "/dashboard\u0000",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,x",
  "vbscript:x",
  "mailto:x@evil.test",
  "evil.test",
  "dashboard",
  "?x=1",
  "#frag",
  "",
  " /dashboard",
  "/..//evil.test",
  "/%5c%5cevil.test\\",
];

describe("safeReturnTo (A-01)", () => {
  test("accepts local paths and returns the normalized path+search+hash", () => {
    for (const [input, expected] of ACCEPTED) {
      const out = safeReturnTo(input, ORIGIN);
      expect(out, input).toBe(expected);
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  test("rejects everything that could leave the trusted origin", () => {
    for (const input of REJECTED) expect(safeReturnTo(input, ORIGIN), JSON.stringify(input)).toBe("/");
  });

  test("rejects non-strings", () => {
    for (const input of [null, undefined, 5, {}, [], ["/dashboard"], true, Symbol("x")]) expect(safeReturnTo(input, ORIGIN)).toBe("/");
  });

  test("the trusted origin comes from configuration, so a public URL with a path still yields local paths", () => {
    expect(safeReturnTo("/x", "https://vogoban.test/base/")).toBe("/x");
    expect(safeReturnTo("/%2f%2fevil.test", ORIGIN)).toBe("/%2f%2fevil.test");
    expect(new URL(safeReturnTo("/%2f%2fevil.test", ORIGIN), ORIGIN).host).toBe("vogoban.test");
  });

  test("the result always re-validates to itself (idempotent)", () => {
    for (const input of [...ACCEPTED.map(([i]) => i), ...REJECTED]) {
      const once = safeReturnTo(input, ORIGIN);
      expect(safeReturnTo(once, ORIGIN)).toBe(once);
    }
  });
});

describe("login flow through the HTTP server (A-01)", () => {
  let issuer: ReturnType<typeof Bun.serve>;
  let issuerUrl: string;
  let p: Platform;
  let privateKey: CryptoKey;
  let currentNonce = "";
  const CLIENT_ID = "CANARY-client-id";

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "canary-key", alg: "RS256", use: "sig" };
    issuer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/.well-known/openid-configuration") return Response.json({ issuer: issuerUrl, authorization_endpoint: `${issuerUrl}/authorize`, token_endpoint: `${issuerUrl}/token`, jwks_uri: `${issuerUrl}/jwks`, end_session_endpoint: `${issuerUrl}/logout` });
        if (path === "/jwks") return Response.json({ keys: [jwk] });
        if (path === "/token" && req.method === "POST") {
          const form = new URLSearchParams(await req.text());
          if (form.get("grant_type") !== "authorization_code" || !form.get("code_verifier") || form.get("code") !== "CANARY-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
          const idToken = await new SignJWT({ nonce: currentNonce, email: "alice@example.test", email_verified: true, name: "Alice" }).setProtectedHeader({ alg: "RS256", kid: "canary-key" }).setIssuer(issuerUrl).setAudience(CLIENT_ID).setSubject("alice").setIssuedAt().setExpirationTime("5m").sign(privateKey);
          return Response.json({ id_token: idToken, access_token: "CANARY-access", token_type: "Bearer" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    issuerUrl = `http://127.0.0.1:${issuer.port}`;
    p = await startPlatform({ VOGOBAN_PUBLIC_URL: ORIGIN, VOGOBAN_OIDC_ISSUER: issuerUrl, VOGOBAN_OIDC_CLIENT_ID: CLIENT_ID, VOGOBAN_SECURE_COOKIES: "0" });
  });

  afterAll(async () => {
    await p.stop();
    issuer.stop(true);
  });

  async function login(returnTo: string | null) {
    const loginRes = await fetch(`${p.base}/auth/login${returnTo === null ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`, { redirect: "manual" });
    expect(loginRes.status).toBe(302);
    const authorize = new URL(loginRes.headers.get("location")!);
    expect(authorize.origin).toBe(issuerUrl);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    const state = authorize.searchParams.get("state")!;
    currentNonce = authorize.searchParams.get("nonce")!;
    const cb = await fetch(`${p.base}/auth/callback?code=CANARY-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    return { status: cb.status, location: cb.headers.get("location"), cookie: cb.headers.get("set-cookie") };
  }

  test("a local returnTo is honoured and the session cookie is set", async () => {
    const r = await login("/dashboard?x=1#top");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/dashboard?x=1#top");
    expect(r.cookie).toMatch(/^vogoban_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
  });

  test("no returnTo lands on /", async () => {
    expect((await login(null)).location).toBe("/");
  });

  test("the Location header never leaves the trusted origin", async () => {
    for (const candidate of REJECTED) {
      const r = await login(candidate);
      expect(r.status, JSON.stringify(candidate)).toBe(302);
      expect(r.location, JSON.stringify(candidate)).toBe("/");
      expect(new URL(r.location!, ORIGIN).origin).toBe(ORIGIN);
    }
    for (const [candidate, expected] of ACCEPTED) {
      const r = await login(candidate);
      expect(r.location, candidate).toBe(expected);
      expect(new URL(r.location!, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  test("a returnTo tampered in storage is re-validated at redirect time", async () => {
    const loginRes = await fetch(`${p.base}/auth/login?returnTo=%2Fdashboard`, { redirect: "manual" });
    const authorize = new URL(loginRes.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    currentNonce = authorize.searchParams.get("nonce")!;
    await p.store.db.run("UPDATE oidc_states SET return_to = ? WHERE state = ?", ["https://evil.test/pwn", state]);
    const cb = await fetch(`${p.base}/auth/callback?code=CANARY-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
  });

  test("unknown state and failed token exchange are 401, not redirects", async () => {
    const unknown = await fetch(`${p.base}/auth/callback?code=CANARY-code&state=nope`, { redirect: "manual" });
    expect(unknown.status).toBe(401);
    const loginRes = await fetch(`${p.base}/auth/login?returnTo=%2Fdashboard`, { redirect: "manual" });
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const bad = await fetch(`${p.base}/auth/callback?code=WRONG&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("location")).toBeNull();
  });
});

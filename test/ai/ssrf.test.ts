import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createProvider, LlmError, loadAiConfig, type AiConfig } from "../../src/ai/provider.ts";
import { loadPlatformConfig, type PlatformConfig } from "../../src/platform/config.ts";
import { JobFailure, validateOutboundUrl, validateRepositoryUrl } from "../../src/platform/providers.ts";
import { platform, type Platform } from "./helpers.ts";

// Attacker-controlled listener on loopback: every test asserts that nothing Vogoban validated or fetched reached it.
let attacker: ReturnType<typeof Bun.serve>;
let attackerHits: string[] = [];
let p: Platform;
beforeAll(async () => {
  attacker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (attackerHits.push(new URL(req.url).pathname), new Response("owned")) });
  p = await platform();
});
afterAll(() => attacker.stop(true));

const enterprise = (): PlatformConfig => loadPlatformConfig({ VOGOBAN_MODE: "enterprise", VOGOBAN_PUBLIC_URL: "https://vogoban.example", VOGOBAN_OIDC_ISSUER: "https://issuer.example", VOGOBAN_OIDC_CLIENT_ID: "cid", VOGOBAN_DATABASE_URL: "postgres://db.example/v", VOGOBAN_DATA_DIR: "/tmp/vogoban-ssrf-test" });

async function rejection(url: string, cfg: PlatformConfig = enterprise()): Promise<string> {
  try {
    await validateOutboundUrl(url, cfg);
  } catch (error) {
    if (error instanceof JobFailure) return error.code;
    throw error;
  }
  return "ACCEPTED";
}

describe("outbound URL registration guard (validateOutboundUrl, enterprise defaults)", () => {
  const port = () => attacker.port;
  const matrix: [string, () => string, string[]][] = [
    ["loopback 127.0.0.1", () => `https://127.0.0.1:${port()}/v1`, ["PRIVATE_ADDRESS"]],
    ["loopback short form 127.1", () => "https://127.1/v1", ["PRIVATE_ADDRESS"]],
    ["unspecified 0.0.0.0", () => "https://0.0.0.0/v1", ["PRIVATE_ADDRESS"]],
    ["localhost (resolved via DNS/hosts)", () => `https://localhost:${port()}/v1`, ["PRIVATE_ADDRESS", "DNS_FAILED"]],
    ["private 10/8", () => "https://10.0.0.1/v1", ["PRIVATE_ADDRESS"]],
    ["private 172.16/12 low", () => "https://172.16.0.1/v1", ["PRIVATE_ADDRESS"]],
    ["private 172.16/12 high", () => "https://172.31.255.254/v1", ["PRIVATE_ADDRESS"]],
    ["private 192.168/16", () => "https://192.168.1.1/v1", ["PRIVATE_ADDRESS"]],
    ["carrier-grade NAT 100.64/10", () => "https://100.64.0.1/v1", ["PRIVATE_ADDRESS"]],
    ["link-local 169.254/16", () => "https://169.254.1.1/v1", ["PRIVATE_ADDRESS"]],
    ["AWS/Azure metadata 169.254.169.254", () => "https://169.254.169.254/latest/meta-data/", ["PRIVATE_ADDRESS"]],
    ["GCP metadata hostname", () => "https://metadata.google.internal/computeMetadata/v1/", ["PRIVATE_ADDRESS", "DNS_FAILED"]],
    ["AWS IPv6 metadata fd00:ec2::254", () => "https://[fd00:ec2::254]/latest/meta-data/", ["PRIVATE_ADDRESS"]],
    ["IPv6 loopback ::1", () => `https://[::1]:${port()}/v1`, ["PRIVATE_ADDRESS"]],
    ["IPv6 loopback long form", () => "https://[0:0:0:0:0:0:0:1]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv6 unspecified ::", () => "https://[::]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]", () => "https://[::ffff:127.0.0.1]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv4-mapped IPv6 loopback hex [::ffff:7f00:1]", () => "https://[::ffff:7f00:1]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv4-mapped IPv6 metadata [::ffff:a9fe:a9fe]", () => "https://[::ffff:a9fe:a9fe]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv4-mapped IPv6 private [::ffff:10.0.0.1]", () => "https://[::ffff:10.0.0.1]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv6 unique-local fc00::1", () => "https://[fc00::1]/v1", ["PRIVATE_ADDRESS"]],
    ["IPv6 link-local fe80::1", () => "https://[fe80::1]/v1", ["PRIVATE_ADDRESS"]],
    ["hex-encoded IPv4 0x7f000001", () => "https://0x7f000001/v1", ["PRIVATE_ADDRESS"]],
    ["decimal IPv4 2130706433", () => "https://2130706433/v1", ["PRIVATE_ADDRESS"]],
    ["octal IPv4 017700000001", () => "https://017700000001/v1", ["PRIVATE_ADDRESS"]],
    ["mixed octal IPv4 0177.0.0.1", () => "https://0177.0.0.1/v1", ["PRIVATE_ADDRESS"]],
    ["decimal metadata 2852039166", () => "https://2852039166/", ["PRIVATE_ADDRESS"]],
    ["nip.io style name resolving to loopback", () => "https://127.0.0.1.nip.io/v1", ["PRIVATE_ADDRESS", "DNS_FAILED"]],
    ["plain http to a public host", () => "http://api.example.com/v1", ["INSECURE_URL"]],
    ["plain http to loopback", () => `http://127.0.0.1:${port()}/v1`, ["INSECURE_URL"]],
    ["ftp scheme", () => "ftp://127.0.0.1/", ["INSECURE_URL"]],
    ["file scheme", () => "file:///etc/passwd", ["INSECURE_URL"]],
    ["gopher scheme", () => "gopher://127.0.0.1:25/", ["INSECURE_URL"]],
    ["malformed: not a URL", () => "not a url", ["INVALID_URL"]],
    ["malformed: scheme only", () => "https://", ["INVALID_URL"]],
    ["malformed: empty", () => "", ["INVALID_URL"]],
    ["malformed: bracket garbage", () => "https://[::1", ["INVALID_URL"]],
    ["credentials-in-url trick with @", () => "https://api.openai.com@127.0.0.1/v1", ["PRIVATE_ADDRESS"]],
  ];
  for (const [name, url, codes] of matrix) test(`rejects ${name}`, async () => expect(codes).toContain(await rejection(url())));

  test("accepts public IP literals without DNS", async () => {
    expect(await rejection("https://93.184.216.34/v1")).toBe("ACCEPTED");
    expect(await rejection("https://[2606:4700:4700::1111]/v1")).toBe("ACCEPTED");
  });

  test("unresolvable hostnames fail closed (DNS_FAILED), never accepted", async () => {
    expect(await rejection("https://this-host-does-not-exist.invalid/v1")).toBe("DNS_FAILED");
  });

  test("nothing reached the attacker listener during validation", () => expect(attackerHits).toEqual([]));
});

describe("explicit operator allow-lists", () => {
  test("local mode (allowInsecureHttp) permits http to localhost, 127.0.0.1 and [::1] only", async () => {
    const cfg = loadPlatformConfig({ VOGOBAN_MODE: "local", VOGOBAN_DATA_DIR: "/tmp/vogoban-ssrf-test" });
    expect(cfg.allowInsecureHttp).toBe(true);
    for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) expect(await rejection(ok, cfg)).toBe("ACCEPTED");
    expect(await rejection("https://127.0.0.1:11434/v1", cfg)).toBe("ACCEPTED");
    expect(await rejection("http://127.1:11434/v1", cfg)).toBe("ACCEPTED");
    expect(await rejection("http://0.0.0.0:11434/v1", cfg)).toBe("INSECURE_URL");
    expect(await rejection("http://[::ffff:127.0.0.1]:11434/v1", cfg)).toBe("INSECURE_URL");
    expect(await rejection("http://10.0.0.5:11434/v1", cfg)).toBe("INSECURE_URL");
    expect(await rejection("http://169.254.169.254/", cfg)).toBe("INSECURE_URL");
    expect(await rejection("https://10.0.0.5/v1", cfg)).toBe("PRIVATE_ADDRESS");
    expect(await rejection("https://169.254.169.254/", cfg)).toBe("PRIVATE_ADDRESS");
  });

  test("VOGOBAN_GIT_ALLOW_PRIVATE_NETWORKS=1 disables the private-address check for https (documented operator opt-in)", async () => {
    const cfg = loadPlatformConfig({ VOGOBAN_MODE: "enterprise", VOGOBAN_PUBLIC_URL: "https://vogoban.example", VOGOBAN_OIDC_ISSUER: "https://issuer.example", VOGOBAN_OIDC_CLIENT_ID: "cid", VOGOBAN_DATABASE_URL: "postgres://db.example/v", VOGOBAN_DATA_DIR: "/tmp/vogoban-ssrf-test", VOGOBAN_GIT_ALLOW_PRIVATE_NETWORKS: "1" });
    expect(await rejection("https://10.0.0.5/v1", cfg)).toBe("ACCEPTED");
    expect(await rejection("http://10.0.0.5/v1", cfg)).toBe("INSECURE_URL");
  });
});

describe("repository URL guard (validateRepositoryUrl)", () => {
  const cfg = enterprise();
  const code = async (url: string) => {
    try {
      await validateRepositoryUrl(url, cfg);
      return "ACCEPTED";
    } catch (error) {
      return error instanceof JobFailure ? error.code : "OTHER";
    }
  };
  test("only https to allow-listed hosts, no credentials, no file:// outside local mode", async () => {
    expect(await code("http://github.com/acme/repo.git")).toBe("INVALID_REPOSITORY_URL");
    expect(await code("file:///etc")).toBe("INVALID_REPOSITORY_URL");
    expect(await code("https://user:CANARY-TOKEN@github.com/acme/repo.git")).toBe("CREDENTIALS_IN_URL");
    expect(await code("https://127.0.0.1/acme/repo.git")).toBe("HOST_NOT_ALLOWED");
    expect(await code("https://169.254.169.254/acme/repo.git")).toBe("HOST_NOT_ALLOWED");
    expect(await code("https://github.com.evil.example/acme/repo.git")).toBe("HOST_NOT_ALLOWED");
    expect(await code("https://evilgithub.com/acme/repo.git")).toBe("HOST_NOT_ALLOWED");
  });
});

describe("tenant AI settings endpoint applies the guard", () => {
  test("PUT /settings/ai rejects private, metadata and IPv4-mapped loopback endpoints (local mode keeps only plain loopback for co-located models)", async () => {
    for (const endpoint of ["https://10.0.0.1/v1", "https://169.254.169.254/v1", "https://[::ffff:127.0.0.1]/v1", "https://[::ffff:a9fe:a9fe]/v1", "https://[fd00:ec2::254]/v1", "https://[::]/v1", "http://192.168.0.1/v1", "not a url"]) {
      let failure: { status?: number; message?: string } | null = null;
      try {
        await p.call("PUT", "/settings/ai", { provider: "openai-compatible", model: "m", endpoint });
      } catch (error) {
        failure = error as { status?: number };
      }
      expect(failure?.status).toBe(400);
    }
    expect(attackerHits).toEqual([]);
  });

  test("PUT /settings/ai accepts a loopback endpoint only because this harness runs in local mode (operator opt-in for co-located models)", async () => {
    expect(p.services.cfg.allowInsecureHttp).toBe(true);
    const r = (await p.call("PUT", "/settings/ai", { provider: "openai-compatible", model: "m", endpoint: "http://127.0.0.1:11434/v1" })) as { ai: { endpoint: string } };
    expect(r.ai.endpoint).toBe("http://127.0.0.1:11434/v1");
    await p.setAi({ provider: "none", endpoint: null, model: null });
  });
});

describe("provider HTTP client", () => {
  const cfgFor = (endpoint: string): AiConfig => ({ ...loadAiConfig(null), provider: "openai-compatible", model: "fake-model", endpoint, apiKeyEnv: null, timeoutMs: 5000, retries: 0 });

  test("does not follow a 302 from the provider to another host (redirect: manual)", async () => {
    const redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${attacker.port}/redirected` } }) });
    try {
      const provider = createProvider(cfgFor(`http://127.0.0.1:${redirector.port}/v1`), "");
      const err = await provider.complete({ messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe("invalid-response");
      expect((err as LlmError).message).toContain("HTTP 302");
      expect(attackerHits).toEqual([]);
    } finally {
      redirector.stop(true);
    }
  });

  test("does not follow 307/308 either", async () => {
    for (const status of [301, 307, 308]) {
      const redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status, headers: { location: `http://127.0.0.1:${attacker.port}/redirected-${status}` } }) });
      try {
        const err = await createProvider(cfgFor(`http://127.0.0.1:${redirector.port}/v1`), "").complete({ messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
        expect((err as LlmError).kind).toBe("invalid-response");
      } finally {
        redirector.stop(true);
      }
    }
    expect(attackerHits).toEqual([]);
  });

  test("VOGOBAN_OFFLINE=1 refuses any non-loopback endpoint before connecting", async () => {
    const prev = process.env.VOGOBAN_OFFLINE;
    process.env.VOGOBAN_OFFLINE = "1";
    try {
      const err = await createProvider(cfgFor("https://api.openai.example/v1"), "").complete({ messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
      expect((err as LlmError).kind).toBe("not-configured");
    } finally {
      if (prev === undefined) delete process.env.VOGOBAN_OFFLINE;
      else process.env.VOGOBAN_OFFLINE = prev;
    }
  });

  test("the secret never appears in provider error messages", async () => {
    const leaky = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => new Response(`bad request, got ${req.headers.get("authorization")}`, { status: 400 }) });
    try {
      const err = await createProvider(cfgFor(`http://127.0.0.1:${leaky.port}/v1`), "CANARY-API-KEY-5512").complete({ messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
      expect((err as LlmError).message).not.toContain("CANARY-API-KEY-5512");
      expect((err as LlmError).message).toContain("[redacted]");
    } finally {
      leaky.stop(true);
    }
  });
});

describe("known limitations (documented, not fixed here)", () => {
  test.todo("DNS rebinding: validateOutboundUrl resolves the hostname at validation time and again per request, but fetch() resolves independently at connect time; a host that flips to a private address between the lookup and the connect is not caught (fix needs connect-time address pinning in the fetch layer)");
  test.todo("CLI/local provider (loadAiConfig) only requires an http(s) scheme; it does not run validateOutboundUrl because the endpoint comes from the operator's own config file, not from a tenant admin");
});

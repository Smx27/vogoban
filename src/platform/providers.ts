import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import type { PlatformConfig } from "./config.ts";

export type FailureClass = "transient" | "permanent" | "configuration" | "authentication" | "repository_unavailable" | "cancelled";

export class JobFailure extends Error {
  constructor(readonly failureClass: FailureClass, readonly code: string, message: string) {
    super(message);
  }
}

export interface WebhookEvent {
  kind: "push" | "pull_request" | "ping" | "ignored";
  repositoryUrl: string | null;
  branch: string | null;
  commit: string | null;
  baseCommit: string | null;
  baseBranch: string | null;
  pullRequest: number | null;
  action: string | null;
}

/** A code host: how to authenticate git over HTTPS and how to verify and read its webhooks. Analysis itself is provider-neutral git. */
export interface RepositoryProvider {
  id: string;
  hosts: string[];
  authHeader(token: string): string;
  verifyWebhook(headers: Headers, body: string, secret: string): boolean;
  parseWebhook(headers: Headers, payload: any): WebhookEvent;
}

const hmacOk = (secret: string, body: string, signature: string | null, algo: "sha256" | "sha1", prefix: string) => {
  if (!signature?.startsWith(prefix)) return false;
  const expected = Buffer.from(`${prefix}${createHmac(algo, secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};
const constantEq = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const ref = (r: unknown) => (typeof r === "string" ? r.replace(/^refs\/heads\//, "") : null);
const none: WebhookEvent = { kind: "ignored", repositoryUrl: null, branch: null, commit: null, baseCommit: null, baseBranch: null, pullRequest: null, action: null };

export const PROVIDERS: Record<string, RepositoryProvider> = {
  github: {
    id: "github",
    hosts: ["github.com"],
    authHeader: (token) => basic("x-access-token", token),
    verifyWebhook: (h, body, secret) => hmacOk(secret, body, h.get("x-hub-signature-256"), "sha256", "sha256="),
    parseWebhook(h, p) {
      const event = h.get("x-github-event");
      const url = p?.repository?.clone_url ?? p?.repository?.html_url ?? null;
      if (event === "ping") return { ...none, kind: "ping", repositoryUrl: url };
      if (event === "push" && !p.deleted) return { ...none, kind: "push", repositoryUrl: url, branch: ref(p.ref), commit: p.after ?? null };
      if (event === "pull_request" && ["opened", "synchronize", "reopened"].includes(p.action)) return { ...none, kind: "pull_request", repositoryUrl: url, branch: p.pull_request?.head?.ref ?? null, commit: p.pull_request?.head?.sha ?? null, baseBranch: p.pull_request?.base?.ref ?? null, baseCommit: p.pull_request?.base?.sha ?? null, pullRequest: p.number ?? null, action: p.action };
      return { ...none, repositoryUrl: url, action: event };
    },
  },
  gitlab: {
    id: "gitlab",
    hosts: ["gitlab.com"],
    authHeader: (token) => basic("oauth2", token),
    verifyWebhook: (h, _body, secret) => constantEq(h.get("x-gitlab-token"), secret),
    parseWebhook(h, p) {
      const event = h.get("x-gitlab-event");
      const url = p?.project?.git_http_url ?? p?.repository?.git_http_url ?? null;
      if (event === "Push Hook") return { ...none, kind: "push", repositoryUrl: url, branch: ref(p.ref), commit: p.checkout_sha ?? p.after ?? null };
      if (event === "Merge Request Hook" && ["open", "reopen", "update"].includes(p?.object_attributes?.action)) {
        const mr = p.object_attributes;
        return { ...none, kind: "pull_request", repositoryUrl: url, branch: mr.source_branch, commit: mr.last_commit?.id ?? null, baseBranch: mr.target_branch, baseCommit: null, pullRequest: mr.iid ?? null, action: mr.action };
      }
      return { ...none, repositoryUrl: url, action: event };
    },
  },
  "azure-devops": {
    id: "azure-devops",
    hosts: ["dev.azure.com", "visualstudio.com"],
    authHeader: (token) => basic("pat", token),
    // Azure DevOps service hooks authenticate with basic credentials configured on the subscription.
    verifyWebhook: (h, _body, secret) => constantEq(h.get("authorization"), basic("vogoban", secret)),
    parseWebhook(_h, p) {
      const resource = p?.resource;
      const url = resource?.repository?.remoteUrl ?? null;
      if (p?.eventType === "git.push") return { ...none, kind: "push", repositoryUrl: url, branch: ref(resource?.refUpdates?.[0]?.name), commit: resource?.refUpdates?.[0]?.newObjectId ?? null };
      if (p?.eventType === "git.pullrequest.created" || p?.eventType === "git.pullrequest.updated") return { ...none, kind: "pull_request", repositoryUrl: url, branch: ref(resource?.sourceRefName), commit: resource?.lastMergeSourceCommit?.commitId ?? null, baseBranch: ref(resource?.targetRefName), baseCommit: resource?.lastMergeTargetCommit?.commitId ?? null, pullRequest: resource?.pullRequestId ?? null, action: p.eventType };
      return { ...none, repositoryUrl: url, action: p?.eventType ?? null };
    },
  },
  git: {
    id: "git",
    hosts: [],
    authHeader: (token) => (token.includes(":") ? basic(token.split(":")[0]!, token.slice(token.indexOf(":") + 1)) : `Bearer ${token}`),
    verifyWebhook: (h, body, secret) => hmacOk(secret, body, h.get("x-vogoban-signature"), "sha256", "sha256="),
    parseWebhook(_h, p) {
      return p?.event === "push" ? { ...none, kind: "push", repositoryUrl: p.repository ?? null, branch: p.branch ?? null, commit: p.commit ?? null } : none;
    },
  },
};

export function detectProvider(url: string): string {
  if (url.startsWith("file://")) return "git";
  const host = new URL(url).hostname.toLowerCase();
  return Object.values(PROVIDERS).find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.id ?? "git";
}

/** Canonical repository identity (host/path, lowercase, no credentials or .git) used for registration uniqueness and webhook matching. */
export function repositoryIdentity(url: string): string {
  if (url.startsWith("file://")) return url.replace(/\/+$/, "").toLowerCase();
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}${u.pathname.replace(/\.git$/i, "").replace(/\/+$/, "").replace(/\/_git\//, "/").toLowerCase()}`;
}

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i];

/** IPv4-mapped IPv6 literals (the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1) are checked as the IPv4 address they carry. */
function isPrivateAddress(address: string): boolean {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  const v4 = dotted ? dotted[1]! : hex ? `${parseInt(hex[1]!, 16) >> 8}.${parseInt(hex[1]!, 16) & 255}.${parseInt(hex[2]!, 16) >> 8}.${parseInt(hex[2]!, 16) & 255}` : address;
  return PRIVATE.some((p) => p.test(v4));
}

/**
 * Repository URLs are attacker-influenced input: only https (or file:// in local mode) to allow-listed hosts,
 * no embedded credentials, and no resolution to private/link-local addresses unless explicitly allowed (SSRF guard).
 */
/** SSRF guard for server-initiated outbound URLs (AI provider endpoints): https only, no private/link-local targets. */
export async function validateOutboundUrl(raw: string, cfg: PlatformConfig): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new JobFailure("configuration", "INVALID_URL", "endpoint is not a valid URL");
  }
  const localOk = cfg.allowInsecureHttp && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localOk)) throw new JobFailure("configuration", "INSECURE_URL", "endpoint must use https");
  if (cfg.git.allowPrivateNetworks || localOk) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new JobFailure("configuration", "DNS_FAILED", `cannot resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw new JobFailure("configuration", "PRIVATE_ADDRESS", `endpoint ${host} resolves to a private address`);
}

export async function validateRepositoryUrl(raw: string, cfg: PlatformConfig): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new JobFailure("configuration", "INVALID_REPOSITORY_URL", "repository URL is not a valid URL");
  }
  if (u.protocol === "file:") {
    if (!cfg.git.allowFileUrls) throw new JobFailure("configuration", "INVALID_REPOSITORY_URL", "file:// repositories are only allowed in local mode");
    if (!existsSync(decodeURIComponent(u.pathname))) throw new JobFailure("repository_unavailable", "REPOSITORY_NOT_FOUND", "local repository path does not exist");
    return u;
  }
  if (u.protocol !== "https:") throw new JobFailure("configuration", "INVALID_REPOSITORY_URL", "repository URL must use https");
  if (u.username || u.password) throw new JobFailure("configuration", "CREDENTIALS_IN_URL", "credentials must not be embedded in the repository URL; register a credential reference instead");
  if (u.search || u.hash) throw new JobFailure("configuration", "INVALID_REPOSITORY_URL", "repository URL must not contain a query or fragment");
  const host = u.hostname.toLowerCase();
  if (!cfg.git.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) throw new JobFailure("configuration", "HOST_NOT_ALLOWED", `host ${host} is not in the allowed git hosts (${cfg.git.allowedHosts.join(", ")})`);
  if (!cfg.git.allowPrivateNetworks) {
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (addresses.some(isPrivateAddress)) throw new JobFailure("configuration", "PRIVATE_ADDRESS", `host ${host} resolves to a private address`);
  }
  return u;
}

async function git(args: string[], opts: { cwd?: string; auth?: string | null; timeoutSeconds: number; signal?: AbortSignal }): Promise<string> {
  const config = opts.auth ? ["-c", `http.extraHeader=Authorization: ${opts.auth}`] : [];
  const proc = Bun.spawn(["git", ...config, "-c", "protocol.file.allow=always", "-c", "credential.helper=", ...args], {
    cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutSeconds * 1000);
  const abort = () => proc.kill();
  opts.signal?.addEventListener("abort", abort);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", abort);
  if (opts.signal?.aborted) throw new JobFailure("cancelled", "CANCELLED", "cancelled");
  if (code !== 0) {
    const msg = err.replace(/Authorization: [^\n]*/gi, "Authorization: [redacted]").trim().split("\n").slice(-3).join(" ");
    if (/authentication failed|could not read username|403|401|invalid username or password|access denied/i.test(err)) throw new JobFailure("authentication", "GIT_AUTHENTICATION_FAILED", `repository authentication failed: ${msg}`);
    if (/not our ref|couldn't find remote ref|unknown revision/i.test(err)) throw new JobFailure("permanent", "REF_NOT_FOUND", `commit or ref not found: ${msg}`);
    if (/not found|does not appear to be a git repository|no such repository/i.test(err)) throw new JobFailure("repository_unavailable", "REPOSITORY_NOT_FOUND", `repository or ref not found: ${msg}`);
    if (/no space left on device|disk quota exceeded/i.test(err)) throw new JobFailure("transient", "STORAGE_FULL", `local storage full while running git ${args[0]}: ${msg}`);
    if (/could not resolve host|timed out|connection (reset|refused)|early eof|returned error: 5\d\d|temporary failure|unable to access/i.test(err) || code === null || code === 143 || code === 137) throw new JobFailure("transient", "GIT_UNAVAILABLE", `git provider unavailable: ${msg || "timeout"}`);
    throw new JobFailure("permanent", "GIT_FAILED", `git ${args[0]} failed: ${msg}`);
  }
  return out;
}

/** Resolves a branch, tag or commit to a commit id without cloning. */
export async function resolveCommit(url: string, refName: string, auth: string | null, cfg: PlatformConfig): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(refName)) return refName.toLowerCase();
  const out = await git(["ls-remote", url, refName, `refs/heads/${refName}`, `refs/tags/${refName}`], { auth, timeoutSeconds: cfg.git.timeoutSeconds });
  const line = out.split("\n").find((l) => l.trim());
  if (!line) throw new JobFailure("repository_unavailable", "REF_NOT_FOUND", `ref ${refName} not found`);
  return line.split(/\s+/)[0]!;
}

/** Shallow fetch of exactly one commit into a per-repository checkout; the remote URL never contains credentials. */
export async function checkout(dir: string, url: string, commit: string, auth: string | null, cfg: PlatformConfig, signal?: AbortSignal) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(`${dir}/.git`)) {
    await git(["init", "-q", dir], { timeoutSeconds: 60 });
    await git(["remote", "add", "origin", url], { cwd: dir, timeoutSeconds: 60 });
  } else await git(["remote", "set-url", "origin", url], { cwd: dir, timeoutSeconds: 60 });
  await git(["fetch", "-q", "--depth", "1", "origin", commit], { cwd: dir, auth, timeoutSeconds: cfg.git.timeoutSeconds, signal });
  await git(["checkout", "-q", "--force", "--detach", commit], { cwd: dir, timeoutSeconds: 120, signal });
  await git(["clean", "-q", "-ffd", "-e", "obj/", "-e", "bin/"], { cwd: dir, timeoutSeconds: 120, signal });
}

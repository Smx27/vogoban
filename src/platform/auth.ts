import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createHash } from "node:crypto";
import { resolveSecret, type PlatformConfig } from "./config.ts";
import { AccessContext, type Principal } from "./rbac.ts";
import { PlatformStore, randomToken, type User } from "./store.ts";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export class AuthError extends Error {
  constructor(readonly code: "UNAUTHENTICATED" | "INVALID_TOKEN" | "OIDC_UNAVAILABLE" | "LOGIN_FAILED", message: string) {
    super(message);
  }
}

/**
 * Post-login return target: only a local path on the configured public origin is ever used.
 * The trusted origin comes from the platform configuration (publicUrl), never from request headers.
 * Anything the WHATWG URL parser could turn into another origin (backslashes, control characters,
 * scheme-relative or absolute URLs) falls back to "/".
 */
export function safeReturnTo(candidate: unknown, trustedOrigin: string): string {
  if (typeof candidate !== "string" || !candidate) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return "/";
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  let parsed: URL;
  try {
    parsed = new URL(candidate, trustedOrigin);
  } catch {
    return "/";
  }
  if (parsed.origin !== new URL(trustedOrigin).origin) return "/";
  if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** OpenID Connect relying party: authorization code flow with PKCE for the web UI, JWT bearer validation for API/MCP clients. */
export class Oidc {
  private discovery: Discovery | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: PlatformConfig, private readonly store: PlatformStore) {}

  get enabled() {
    return !!(this.cfg.auth.issuer && this.cfg.auth.clientId);
  }

  private async meta(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    try {
      const res = await fetch(`${this.cfg.auth.issuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as Discovery;
      if (d.issuer.replace(/\/+$/, "") !== this.cfg.auth.issuer!.replace(/\/+$/, "")) throw new Error("discovery issuer mismatch");
      this.discovery = d;
      this.jwks = createRemoteJWKSet(new URL(d.jwks_uri));
      return d;
    } catch (error) {
      throw new AuthError("OIDC_UNAVAILABLE", `identity provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async ready(): Promise<boolean> {
    if (!this.enabled) return true;
    try {
      await this.meta();
      return true;
    } catch {
      return false;
    }
  }

  async loginUrl(returnTo: string | null): Promise<string> {
    const d = await this.meta();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.store.saveOidcState(state, verifier, nonce, safeReturnTo(returnTo, this.cfg.publicUrl));
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: this.cfg.auth.clientId!, redirect_uri: `${this.cfg.publicUrl}/auth/callback`, scope: this.cfg.auth.scopes.join(" "), state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return url.toString();
  }

  async callback(code: string, state: string): Promise<{ claims: JWTPayload; returnTo: string }> {
    const saved = await this.store.takeOidcState(state);
    if (!saved) throw new AuthError("LOGIN_FAILED", "unknown or expired login state");
    const d = await this.meta();
    const secret = resolveSecret(this.cfg.auth.clientSecretRef);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${this.cfg.publicUrl}/auth/callback`, code_verifier: saved.verifier, client_id: this.cfg.auth.clientId! });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.auth.clientId!)}:${encodeURIComponent(secret)}`).toString("base64")}`;
    const res = await fetch(d.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new AuthError("LOGIN_FAILED", `token exchange failed (HTTP ${res.status})`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new AuthError("LOGIN_FAILED", "identity provider returned no id_token");
    const { payload } = await jwtVerify(tokens.id_token, this.jwks!, { issuer: d.issuer, audience: this.cfg.auth.clientId! });
    if (payload.nonce !== saved.nonce) throw new AuthError("LOGIN_FAILED", "nonce mismatch");
    return { claims: payload, returnTo: safeReturnTo(saved.returnTo, this.cfg.publicUrl) };
  }

  async verifyBearer(token: string): Promise<JWTPayload> {
    const d = await this.meta();
    try {
      const { payload } = await jwtVerify(token, this.jwks!, { issuer: d.issuer, audience: this.cfg.auth.audience ?? this.cfg.auth.clientId! });
      return payload;
    } catch (error) {
      throw new AuthError("INVALID_TOKEN", `bearer token rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async logoutUrl(): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      return (await this.meta()).end_session_endpoint ?? null;
    } catch {
      return null;
    }
  }
}

export interface Authenticated {
  principal: Principal;
  user: User | null;
  tokenTenantId: string | null;
  method: "session" | "oidc-bearer" | "api-token";
}

const emailOf = (claims: JWTPayload) => (typeof claims.email === "string" && claims.email_verified !== false ? claims.email.toLowerCase() : null);

export async function userFromClaims(store: PlatformStore, cfg: PlatformConfig, claims: JWTPayload): Promise<User> {
  if (!claims.iss || !claims.sub) throw new AuthError("INVALID_TOKEN", "token has no issuer/subject");
  const user = await store.upsertLogin(claims.iss, claims.sub, emailOf(claims), typeof claims.name === "string" ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : null);
  if (user.status !== "active") throw new AuthError("UNAUTHENTICATED", "user is disabled");
  await store.acceptInvitations(user);
  return user;
}

export const isOperator = (cfg: PlatformConfig, user: User | null) => !!user?.email && cfg.auth.operators.includes(user.email.toLowerCase());

/** Resolves the caller from (in order) a platform API token, an OIDC bearer JWT, or a web session cookie. */
export async function authenticate(req: Request, store: PlatformStore, oidc: Oidc, cfg: PlatformConfig): Promise<Authenticated | null> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.startsWith("vgb_")) {
      const t = await store.tokenBySecret(token);
      if (!t) throw new AuthError("INVALID_TOKEN", "API token is unknown, revoked or expired");
      const user = t.userId ? await store.user(t.userId) : null;
      if (t.userId && user?.status !== "active") throw new AuthError("INVALID_TOKEN", "API token owner is disabled");
      return { principal: { type: t.kind === "personal" ? "user" : "token", id: t.kind === "personal" ? t.userId! : t.id, userId: t.userId, label: `token:${t.name}`, operator: false }, user, tokenTenantId: t.tenantId, method: "api-token" };
    }
    if (!oidc.enabled) throw new AuthError("INVALID_TOKEN", "OIDC is not configured; use a platform API token");
    const claims = await oidc.verifyBearer(token);
    const user = await userFromClaims(store, cfg, claims);
    return { principal: { type: "user", id: user.id, userId: user.id, label: user.email ?? user.id, operator: isOperator(cfg, user) }, user, tokenTenantId: null, method: "oidc-bearer" };
  }
  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("vogoban_session="))?.slice("vogoban_session=".length);
  if (cookie) {
    const s = await store.session(cookie);
    if (!s) return null;
    const user = await store.user(s.userId);
    if (!user || user.status !== "active") return null;
    return { principal: { type: "user", id: user.id, userId: user.id, label: user.email ?? user.id, operator: isOperator(cfg, user) }, user, tokenTenantId: null, method: "session" };
  }
  return null;
}

/** Builds the caller's effective permissions inside one tenant. Users need an active membership; tokens are bound to their tenant. */
export async function accessFor(store: PlatformStore, auth: Authenticated, tenantId: string): Promise<AccessContext | null> {
  if (auth.tokenTenantId && auth.tokenTenantId !== tenantId) return null;
  const principalIds: string[] = [];
  if (auth.principal.type === "token") principalIds.push(auth.principal.id);
  let bindings: Awaited<ReturnType<PlatformStore["bindings"]>> = [];
  if (auth.principal.type === "token") bindings = await store.bindings(tenantId, { principalType: "token", principalIds });
  else {
    if ((await store.membership(tenantId, auth.principal.id)) !== "active") return null;
    const teams = await store.userTeams(tenantId, auth.principal.id);
    bindings = [...(await store.bindings(tenantId, { principalType: "user", principalIds: [auth.principal.id] })), ...(await store.bindings(tenantId, { principalType: "team", principalIds: teams }))];
  }
  const repos = (await store.repositories(tenantId)).map((r) => ({ id: r.id, teamId: r.teamId }));
  const tree = new Map((await store.teams(tenantId)).map((t) => [t.id, t.parentId]));
  return new AccessContext(tenantId, auth.principal, bindings, repos, tree);
}

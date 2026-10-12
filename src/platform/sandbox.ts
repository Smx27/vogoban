import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { platformLogger } from "./telemetry.ts";

/** Repository root (…/src/platform -> repo root). */
export const APP_DIR = join(import.meta.dir, "../..");
const SANDBOX_SCRIPT = join(import.meta.dir, "sandbox.sh");

export interface SandboxPlan {
  /** Analysis of untrusted repository code is confined (filesystem + network). */
  available: boolean;
  /** How confinement is achieved, for logs and the audit trail. */
  mode: "namespace-jail" | "static-only" | "trusted-unconfined";
  reason: string;
  /** `nugetDir` is the tenant's private NuGet root (tenantNugetDir): it is the only package cache the analysis can see or write. */
  wrap(command: string[], tenantDir: string, nugetDir: string): string[];
  env(base: Record<string, string>, nugetDir: string): Record<string, string>;
}

/**
 * Every tenant gets its own NuGet root inside its tenant directory. `dotnet restore` runs repository-controlled
 * MSBuild logic (property functions can write files) and the jailed analyzer mounts the package cache read-write,
 * so a shared `$HOME/.nuget` would let one tenant's repository plant packages or metadata that another tenant's
 * analysis then reads. Isolation costs duplicate downloads per tenant.
 */
export const tenantNugetDir = (tenantDir: string) => join(tenantDir, ".nuget");

const log = platformLogger("sandbox");

/** Environment allowlist for the analyzer subprocess: only toolchain and correlation, never platform or provider secrets. */
const ALLOWED_ENV = /^(PATH|HOME|LANG|LC_[A-Z]+|TZ|TMPDIR|DOTNET_[A-Z_]+|NUGET_[A-Z_]+|MSBUILD[A-Z]*|VOGOBAN_(CORRELATION_ID|JOB_ID|MSBUILD_EVALUATION))$/;

function cleanEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && ALLOWED_ENV.test(k)) out[k] = v;
  out.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
  out.DOTNET_NOLOGO = "1";
  return out;
}

function unshareArgs() {
  return ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--net"];
}

/** One-time probe: can we create a user+mount+PID+net namespace, mount a private /proc and pivot_root into a tmpfs? */
function probe(): boolean {
  try {
    const r = Bun.spawnSync(["unshare", ...unshareArgs(), "--", "sh", "-c", "mount --make-rprivate / 2>/dev/null; d=$(mktemp -d); mount -t tmpfs t \"$d\" && mkdir -p \"$d/o\" \"$d/proc\" && mount -t proc proc \"$d/proc\" && cd \"$d\" && pivot_root . o && exit 0 || exit 1"], { stdout: "ignore", stderr: "pipe" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

let cached: SandboxPlan | null = null;

/**
 * Decides how to confine repository analysis. Analysis evaluates repository-controlled build files (MSBuild
 * property functions can read files and environment), so untrusted repositories must not run with access to
 * the host, other tenants' data, or the network.
 *   namespace-jail   — confined to the toolchain, SDK, NuGet cache and one tenant directory; no network.
 *   static-only      — no sandbox available: MSBuild evaluation is disabled so no repository code is executed.
 *   trusted-unconfined — operator has declared repositories trusted (VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1).
 */
export function sandboxPlan(dotnetDir: string): SandboxPlan {
  if (cached) return cached;
  const trusted = process.env.VOGOBAN_ANALYSIS_TRUST_REPOSITORIES === "1";
  const canJail = existsSync(SANDBOX_SCRIPT) && probe();
  if (canJail) {
    cached = {
      available: true, mode: "namespace-jail", reason: "user+mount+net namespace jail",
      wrap: (command, tenantDir, nugetDir) => ["unshare", ...unshareArgs(), "--", SANDBOX_SCRIPT, tenantDir, APP_DIR, dotnetDir, nugetDir, "--", ...command],
      env: (base, nugetDir) => ({ ...cleanEnv(base), NUGET_PACKAGES: join(nugetDir, "packages"), HOME: tenantHome(nugetDir), DOTNET_CLI_HOME: tenantHome(nugetDir) }),
    };
  } else if (trusted) {
    cached = { available: false, mode: "trusted-unconfined", reason: "no namespace sandbox; VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1", wrap: (c) => c, env: (base, nugetDir) => ({ ...cleanEnv(base), NUGET_PACKAGES: join(nugetDir, "packages"), HOME: tenantHome(nugetDir), DOTNET_CLI_HOME: tenantHome(nugetDir) }) };
  } else {
    cached = {
      available: false, mode: "static-only", reason: "no namespace sandbox; MSBuild evaluation disabled so repository build logic is not executed",
      wrap: (c) => c, env: (base, nugetDir) => ({ ...cleanEnv(base), VOGOBAN_MSBUILD_EVALUATION: "0", NUGET_PACKAGES: join(nugetDir, "packages"), HOME: tenantHome(nugetDir), DOTNET_CLI_HOME: tenantHome(nugetDir) }),
    };
  }
  log.info("sandbox.plan", { mode: cached.mode, reason: cached.reason });
  if (cached.mode === "trusted-unconfined") log.warn("sandbox.trusted", { message: "repository analysis runs unconfined; only analyze trusted repositories" });
  return cached;
}

/** The tenant directory that owns a NuGet root; used as HOME so NuGet/dotnet user state (NuGet.Config, http cache, plugins) is per tenant too. */
const tenantHome = (nugetDir: string) => dirname(nugetDir);

export const sandboxDotnetDir = () => (process.env.VOGOBAN_DOTNET ? dirname(process.env.VOGOBAN_DOTNET) : existsSync(`${process.env.HOME}/.dotnet/dotnet`) ? `${process.env.HOME}/.dotnet` : "/usr/share/dotnet");

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxDotnetDir, sandboxPlan, tenantNugetDir } from "../../src/platform/sandbox.ts";
import { restoreEnv } from "../../src/platform/worker.ts";

/**
 * Hostile repository inside the actual worker confinement (namespace jail) and cross-tenant NuGet isolation.
 * The jail is probed exactly as the worker does; when the host cannot create user+mount+net namespaces the jail
 * tests are skipped with that reason (the worker would then run static-only).
 */

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "main.ts");
const HOST_CANARY = "HOST-SECRET-CANARY-JAIL-5521";
const NUGET_CANARY = "NUGET-POISON-CANARY-9931";
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".capy", "work", "dotnet", "dotnet"), join(process.env.HOME ?? "", ".dotnet", "dotnet")].find((c) => c && existsSync(c)) ?? null;
if (dotnet && !process.env.VOGOBAN_DOTNET) process.env.VOGOBAN_DOTNET = dotnet;

let work: string;
let home: string;
let tenantA: string;
let tenantB: string;
const plan = sandboxPlan(sandboxDotnetDir());

const baseEnv = (): Record<string, string> => ({ PATH: `${dotnet ? join(dotnet, "..") : ""}:${process.env.PATH ?? ""}`, HOME: home, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", ...(dotnet ? { VOGOBAN_DOTNET: dotnet } : {}) });

function jailed(command: string[], tenantDir: string): { code: number; stdout: string; stderr: string } {
  const nugetDir = tenantNugetDir(tenantDir);
  mkdirSync(join(nugetDir, "packages"), { recursive: true });
  const p = Bun.spawnSync(plan.wrap(command, tenantDir, nugetDir), { env: plan.env(baseEnv(), nugetDir), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "vogoban-jail-"));
  home = join(work, "home");
  tenantA = join(work, "tenants", "tenant-a");
  tenantB = join(work, "tenants", "tenant-b");
  mkdirSync(join(home, ".nuget", "packages"), { recursive: true });
  mkdirSync(tenantA, { recursive: true });
  mkdirSync(tenantB, { recursive: true });
  writeFileSync(join(home, "secret.txt"), HOST_CANARY);
  writeFileSync(join(tenantB, "tenant-b-secret.txt"), `${HOST_CANARY}-tenant-b`);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("cross-tenant NuGet isolation", () => {
  test("restore and jailed analysis use a private NuGet root per tenant, never $HOME/.nuget", () => {
    const a = restoreEnv(tenantA);
    const b = restoreEnv(tenantB);
    expect(a.NUGET_PACKAGES).toBe(join(tenantA, ".nuget", "packages"));
    expect(b.NUGET_PACKAGES).toBe(join(tenantB, ".nuget", "packages"));
    expect(a.HOME).toBe(tenantA);
    expect(b.HOME).toBe(tenantB);
    expect(a.NUGET_PACKAGES.startsWith(process.env.HOME ?? "/nonexistent")).toBe(false);
    for (const t of [tenantA, tenantB]) {
      const env = plan.env({ HOME: process.env.HOME ?? "/tmp", PATH: process.env.PATH ?? "" }, tenantNugetDir(t));
      expect(env.NUGET_PACKAGES).toBe(join(t, ".nuget", "packages"));
      expect(env.HOME).toBe(t);
    }
  });

  test.skipIf(!dotnet)("a repository whose restore writes into its package root cannot reach another tenant or the worker home", () => {
    const repo = join(tenantA, "checkouts", "hostile");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "Hostile.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <Target Name="Poison" BeforeTargets="Restore;_GenerateRestoreProjectSpec;CollectPackageReferences">
    <WriteLinesToFile File="$(NUGET_PACKAGES)/poison.marker" Lines="${NUGET_CANARY}" Overwrite="true" />
    <WriteLinesToFile File="$(NUGET_PACKAGES)/../../../tenant-b/poison.marker" Lines="${NUGET_CANARY}" Overwrite="true" ContinueOnError="true" />
  </Target>
</Project>
`);
    const env = { ...restoreEnv(tenantA), PATH: baseEnv().PATH, DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
    const r = Bun.spawnSync([dotnet!, "restore", "Hostile.csproj", "--nologo"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(tenantA, ".nuget", "packages", "poison.marker"))).toBe(true);
    expect(existsSync(join(home, ".nuget", "packages", "poison.marker"))).toBe(false);
    expect(existsSync(join(process.env.HOME ?? "/nonexistent", ".nuget", "packages", "poison.marker"))).toBe(false);
    expect(existsSync(join(tenantB, ".nuget", "packages", "poison.marker"))).toBe(false);
    rmSync(join(tenantB, "poison.marker"), { force: true });
  });
});

describe("hostile repository inside the worker jail", () => {
  const skip = () => plan.mode !== "namespace-jail";

  test("jail availability is reported", () => {
    if (skip()) console.warn(`namespace jail unavailable on this host (${plan.reason}); jail tests skipped`);
    expect(["namespace-jail", "static-only", "trusted-unconfined"]).toContain(plan.mode);
  });

  test.skipIf(skip())("no host file escape, no writable host paths, other tenants invisible, no network, package cache per tenant", () => {
    const probe = [
      `cat ${join(home, "secret.txt")} 2>/dev/null && echo READ_HOME || echo NO_HOME`,
      `cat ${join(tenantB, "tenant-b-secret.txt")} 2>/dev/null && echo READ_TENANT_B || echo NO_TENANT_B`,
      `ls ${join(work, "tenants")} 2>/dev/null | grep -q tenant-b && echo LIST_TENANT_B || echo NO_LIST_TENANT_B`,
      `touch ${ROOT}/jail-write-probe 2>/dev/null && echo WROTE_APP || echo RO_APP`,
      `touch /usr/jail-write-probe 2>/dev/null && echo WROTE_USR || echo RO_USR`,
      `touch ${join(home, "jail-write-probe")} 2>/dev/null && echo WROTE_HOME || echo NO_HOME_WRITE`,
      `touch ${join(tenantA, "jail-write-probe")} 2>/dev/null && echo WROTE_TENANT || echo RO_TENANT`,
      `echo ${NUGET_CANARY} > "$NUGET_PACKAGES/jail-poison.marker" 2>/dev/null && echo WROTE_NUGET || echo RO_NUGET`,
      `ls ${join(home, ".nuget", "packages")} 2>/dev/null | grep -q . && echo SEES_SHARED_NUGET || echo NO_SHARED_NUGET`,
      `ls /sys/class/net 2>/dev/null | grep -v '^lo$' | grep -q . && echo HAS_NET_IF || echo NO_NET_IF`,
      `(exec 3<>/dev/tcp/127.0.0.1/${listenerPort} && echo CONNECTED) 2>/dev/null || echo NO_CONNECT`,
      `(exec 3<>/dev/tcp/1.1.1.1/443 && echo CONNECTED_WAN) 2>/dev/null || echo NO_WAN`,
    ].join("; ");
    const r = jailed(["sh", "-c", probe], tenantA);
    const out = r.stdout;
    expect(out).toContain("NO_HOME");
    expect(out).toContain("NO_TENANT_B");
    expect(out).toContain("NO_LIST_TENANT_B");
    expect(out).toContain("RO_APP");
    expect(out).toContain("RO_USR");
    expect(out).toContain("NO_HOME_WRITE");
    expect(out).toContain("WROTE_TENANT");
    expect(out).toContain("WROTE_NUGET");
    expect(out).toContain("NO_SHARED_NUGET");
    expect(out).toContain("NO_NET_IF");
    expect(out).toContain("NO_CONNECT");
    expect(out).toContain("NO_WAN");
    expect(existsSync(join(tenantA, ".nuget", "packages", "jail-poison.marker"))).toBe(true);
    expect(existsSync(join(tenantB, ".nuget", "packages", "jail-poison.marker"))).toBe(false);
    expect(existsSync(join(home, ".nuget", "packages", "jail-poison.marker"))).toBe(false);
    expect(existsSync(join(ROOT, "jail-write-probe"))).toBe(false);
    rmSync(join(tenantA, "jail-write-probe"), { force: true });
    expect(listenerHits).toBe(0);
  });

  test.skipIf(skip() || !dotnet)("hostile .NET repository analyzed in the jail leaks no host secret and escapes no symlink", () => {
    const repo = join(tenantA, "checkouts", "hostile-dotnet");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <HostSecret>$([System.IO.File]::Exists('${join(home, "secret.txt")}'))</HostSecret>
    <DefineConstants>$(DefineConstants);HOSTEXISTS_$(HostSecret)</DefineConstants>
    <AssemblyName>Hostile$([System.IO.File]::Exists('${join(tenantB, "tenant-b-secret.txt")}'))</AssemblyName>
  </PropertyGroup>
  <ItemGroup><Compile Include="${join(home, "secret.txt")}" /><Compile Include="../../../../../tenant-b/tenant-b-secret.txt" /></ItemGroup>
</Project>
`);
    writeFileSync(join(repo, "src", "Program.cs"), "namespace Hostile { public static class Program { public static void Main() { } } }\n");
    symlinkSync(join(home, "secret.txt"), join(repo, "src", "Leak.cs"));
    const db = join(tenantA, "graph.db");
    const r = jailed([process.execPath, CLI, "analyze", repo, "--db", db, "--log-json", "--log-level", "info"], tenantA);
    expect(r.code).toBe(0);
    const d = new Database(db, { readonly: true });
    const tables = (d.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    let all = "";
    for (const t of tables) for (const row of d.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) all += JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)) + "\n";
    d.close();
    expect(all).not.toContain(HOST_CANARY);
    expect(all).not.toContain("HOSTEXISTS_True");
    expect(all).not.toContain("HostileTrue");
    expect(r.stderr).not.toContain(HOST_CANARY);
    expect(all).toContain("Hostile.Program");
  });
});

let listenerPort = 0;
let listenerHits = 0;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { listenerHits++; return new Response("x"); } });
listenerPort = listener.port!;
afterAll(() => listener.stop(true));

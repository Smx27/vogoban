import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const source = join(import.meta.dir, "../..");
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".dotnet/dotnet"), join(process.env.HOME ?? "", ".capy/work/dotnet/dotnet")].find((path) => path && existsSync(path));
const roots: string[] = [];
const env = { ...process.env, VOGOBAN_DOTNET: dotnet, VOGOBAN_MSBUILD_EVALUATION: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vogoban-semantic-references-"));
  roots.push(root);
  return root;
}

function analyze(root: string, untrusted = false) {
  const dbPath = join(root, untrusted ? "untrusted.db" : "graph.db");
  run(["bun", join(source, "src/cli/main.ts"), "analyze", join(root, "consumer"), "--db", dbPath, "--log-level", "error", ...(untrusted ? ["--untrusted"] : [])], source);
  const db = new Database(dbPath, { readonly: true });
  try {
    const project = db.query("SELECT metadata FROM entities WHERE kind = 'Project' AND name = 'Consumer'").get() as { metadata: string };
    const symbols = db.query("SELECT qualified_name FROM entities WHERE kind = 'Type' AND external = 0").all() as { qualified_name: string }[];
    const payloads = db.query("SELECT payload FROM fact_cache WHERE scope LIKE 'semantic|%'").all() as { payload: string }[];
    return { metadata: JSON.parse(project.metadata), symbols, facts: payloads.map((row) => JSON.parse(row.payload)) };
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!dotnet)("upgraded package references replace older framework assemblies", () => {
  const root = fixture();
  write(root, "dependency/Upgrade.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AssemblyName>Microsoft.Extensions.Configuration.Abstractions</AssemblyName><AssemblyVersion>10.0.0.0</AssemblyVersion></PropertyGroup></Project>`);
  write(root, "dependency/Upgrade.cs", "namespace Vendor; public static class Upgrade { public static string Value() => string.Empty; }");
  run([dotnet!, "build", "dependency/Upgrade.csproj", "--nologo", "-v", "q"], root);
  write(root, "consumer/Consumer.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Reference Include="Microsoft.Extensions.Configuration.Abstractions"><HintPath>../dependency/bin/Debug/net8.0/Microsoft.Extensions.Configuration.Abstractions.dll</HintPath></Reference></ItemGroup></Project>`);
  write(root, "consumer/Consumer.cs", "public class Consumer { public string Read() => Vendor.Upgrade.Value(); }");
  const result = analyze(root);
  expect(result.metadata.compilerErrors).toBe(0);
  const assembly = result.facts.flatMap((p) => p.frameworks).flatMap((f) => f.usedAssemblies).find((a) => a.name === "Microsoft.Extensions.Configuration.Abstractions");
  expect(assembly.version).toBe("10.0.0.0");
  expect(assembly.source).toBe("package");
});

test.skipIf(!dotnet)("older package references do not replace newer framework assemblies", () => {
  const root = fixture();
  write(root, "dependency/Upgrade.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AssemblyName>Microsoft.Extensions.Configuration.Abstractions</AssemblyName><AssemblyVersion>7.0.0.0</AssemblyVersion></PropertyGroup></Project>`);
  write(root, "dependency/Upgrade.cs", "namespace Vendor; public class OldPackage { }");
  run([dotnet!, "build", "dependency/Upgrade.csproj", "--nologo", "-v", "q"], root);
  write(root, "consumer/Consumer.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Reference Include="Microsoft.Extensions.Configuration.Abstractions"><HintPath>../dependency/bin/Debug/net8.0/Microsoft.Extensions.Configuration.Abstractions.dll</HintPath></Reference></ItemGroup></Project>`);
  write(root, "consumer/Consumer.cs", "public class Consumer { public Microsoft.Extensions.Configuration.IConfiguration Configuration = null!; }");
  const result = analyze(root);
  expect(result.metadata.compilerErrors).toBe(0);
  const assembly = result.facts.flatMap((p) => p.frameworks).flatMap((f) => f.usedAssemblies).find((a) => a.name === "Microsoft.Extensions.Configuration.Abstractions");
  expect(assembly.version).toBe("8.0.0.0");
  expect(assembly.source).toBe("framework");
});

test.skipIf(!dotnet)("built sibling references resolve without importing source or caching stale binaries", () => {
  const root = fixture();
  write(root, "dependency/Contracts.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AssemblyName>Sibling.Contracts</AssemblyName><OutputPath>artifacts/custom/</OutputPath></PropertyGroup><Target Name="ExecutionProbe" BeforeTargets="Build"><WriteLinesToFile File="$(MSBuildProjectDirectory)/executed.txt" Lines="executed"/></Target></Project>`);
  write(root, "dependency/Contract.cs", "namespace Contracts; public static class Contract { public static string Read() => string.Empty; }");
  run([dotnet!, "build", "dependency/Contracts.csproj", "--nologo", "-v", "q"], root);
  rmSync(join(root, "dependency/executed.txt"));
  const project = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../dependency/Contracts.csproj"/></ItemGroup></Project>`;
  write(root, "consumer/Consumer.csproj", project);
  write(root, "consumer/Consumer.cs", "public class Consumer { public string Read() => Contracts.Contract.Read(); }");
  const initial = analyze(root);
  expect(initial.metadata.compilerErrors).toBe(0);
  expect(initial.symbols.map((s) => s.qualified_name)).toContain("Consumer");
  expect(initial.symbols.map((s) => s.qualified_name)).not.toContain("Contracts.Contract");
  expect(initial.facts).toHaveLength(0);
  expect(existsSync(join(root, "dependency/executed.txt"))).toBe(false);
  expect(analyze(root, true).metadata.compilerErrors).toBeGreaterThan(0);
  write(root, "consumer/Consumer.csproj", project.replace("<ProjectReference ", '<ProjectReference ReferenceOutputAssembly="false" '));
  expect(analyze(root).metadata.compilerErrors).toBeGreaterThan(0);
  write(root, "consumer/Consumer.csproj", project);
  write(root, "dependency/Contract.cs", "namespace Contracts; public static class Contract { public static int Read() => 1; }");
  run([dotnet!, "build", "dependency/Contracts.csproj", "--nologo", "-v", "q"], root);
  expect(analyze(root).metadata.compilerErrors).toBeGreaterThan(0);
});

test.skipIf(!dotnet)("imported sibling references are not cached across dependency rebuilds", () => {
  const root = fixture();
  write(root, "dependency/Contracts.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`);
  write(root, "dependency/Contract.cs", "namespace Contracts; public static class Contract { public static string Read() => string.Empty; }");
  run([dotnet!, "build", "dependency/Contracts.csproj", "--nologo", "-v", "q"], root);
  write(root, "consumer/Consumer.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`);
  write(root, "consumer/Directory.Build.targets", `<Project><ItemGroup><ProjectReference Include="../dependency/Contracts.csproj"/></ItemGroup></Project>`);
  write(root, "consumer/Consumer.cs", "public class Consumer { public string Read() => Contracts.Contract.Read(); }");
  expect(analyze(root).metadata.compilerErrors).toBe(0);
  write(root, "dependency/Contract.cs", "namespace Contracts; public static class Contract { public static int Read() => 1; }");
  run([dotnet!, "build", "dependency/Contracts.csproj", "--nologo", "-v", "q"], root);
  expect(analyze(root).metadata.compilerErrors).toBeGreaterThan(0);
});

test.skipIf(!dotnet)("multi-target project metadata selects a compatible .NET Standard output", () => {
  const root = fixture();
  write(root, "dependency/Contracts.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>netstandard2.1</TargetFrameworks></PropertyGroup></Project>`);
  write(root, "dependency/Contract.cs", "namespace Contracts { public static class Contract { public static string Read() => string.Empty; } }");
  run([dotnet!, "build", "dependency/Contracts.csproj", "--nologo", "-v", "q"], root);
  write(root, "consumer/Consumer.csproj", `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../dependency/Contracts.csproj"/></ItemGroup></Project>`);
  write(root, "consumer/Consumer.cs", "public class Consumer { public string Read() => Contracts.Contract.Read(); }");
  expect(analyze(root).metadata.compilerErrors).toBe(0);
});

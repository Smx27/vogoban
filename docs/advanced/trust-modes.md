# Trust modes

Vogoban's analyzers never run repository code, with one exception: evaluating .NET project files with MSBuild. This page explains what MSBuild evaluation is, when the CLI and the platform worker allow it, and what you lose when it is off.

## What MSBuild evaluation is and why it matters

A `.csproj` file is a program, not just a list of settings. Before anything is compiled, MSBuild *evaluates* the project: it imports SDK props and targets, `Directory.Build.props`/`.targets` files, evaluates conditions and property functions, and expands item globs. The result is the real list of source files, references, defined constants and generated sources the compiler sees.

Vogoban's Roslyn analyzer can do this evaluation itself (through Microsoft.Build) to get the same project model a build would. That gives the most faithful graph, but property functions in a repository's build files can read files and environment variables, and SDK imports chosen by the repository run during evaluation. For a repository you did not write, that is code execution.

With evaluation **off**, Vogoban reads project files statically: properties, `PackageReference`, `ProjectReference`, `Compile` items and the restore output (`obj/project.assets.json`) are parsed as data, and SDK logic is not executed. Analysis still uses Roslyn for semantic compilation of the C# sources; only the project model comes from static parsing.

Nothing else in Vogoban executes repository content. TypeScript, Bicep, Terraform, Helm, YAML and JSON are parsed, never executed, and nothing contacts Azure or any other service.

## The modes at a glance

| Where | Mode | MSBuild evaluation | Confinement | Use for |
|---|---|---|---|---|
| CLI `analyze`, `graph sync` (no commit range) | trusted (default) | on | none (runs as you) | your own checkout |
| Any CLI command with `--untrusted` | untrusted | off | none, but no repository code runs | code you did not write |
| CLI `graph sync --base/--head` (or `--from/--to`) | untrusted by default | off | none, but no repository code runs | pull requests in CI |
| CLI `graph sync --base/--head --trust-repository` | trusted | on | none | CI on a repository you trust |
| Platform worker `namespace-jail` | trusted inside a jail | on | user+mount+PID+network namespaces | multi-tenant platform (preferred) |
| Platform worker `static-only` | untrusted | off | none needed | platform without namespace support |
| Platform worker `trusted-unconfined` | trusted | on | none | platform where every repository is trusted |

`--untrusted` and the CI rule set `VOGOBAN_MSBUILD_EVALUATION=0` for the process. Setting that variable yourself has the same effect.

## CLI: trusted, untrusted and CI

Local analysis of your own checkout is trusted:

```bash
vogoban analyze .
```

Force static project reading for code you do not trust:

```bash
vogoban analyze ./third-party-repo --untrusted
```

A commit-range sync is what CI runs on pull requests, so it is untrusted unless you opt in. Without `--json`, the CLI says so on stderr:

```bash
vogoban graph sync --base "$BASE_SHA" --head "$HEAD_SHA"
```

```text
note: repository build evaluation is disabled in CI mode (static analysis only); use --trust-repository on a trusted repository for full fidelity
```

Opt in only when the repository and the change are trusted (for example a protected branch build):

```bash
vogoban graph sync --base "$BASE_SHA" --head "$HEAD_SHA" --trust-repository
```

`--trust-repository` has no effect outside a commit-range sync; local `analyze` and `graph sync` are already trusted.

### Changing mode forces a full rebuild

The evaluation mode is part of the analysis model. It is recorded per repository and is part of every per-project cache key, so switching mode on an existing graph is never an incremental update. Real run: a trusted `analyze` followed by an untrusted sync of the same commit:

```bash
vogoban analyze .
vogoban graph sync --untrusted
```

```text
contoso-orders: FULL (FALLBACK) — repository build evaluation mode changed (on -> off); the analysis trust model differs
  fallback: repository build evaluation mode changed (on -> off); the analysis trust model differs [evaluation_mode_changed] (requested incremental, ran full)
  commit 474e594750ac -> 474e594750ac  [working-tree]
  graph version 4d33f5467405 -> 2635138a93e4
  changed files 0  ·  analyzed 42  ·  affected projects 0
  reconciled entities +0 ~4 -6  relationships +0 ~18 -45
  duration 2059 ms (baseline full 2989 ms)
  diff: vogoban diff --from gs_86a8ab158612ca84b7c55d51 --to gs_84eca58655329ab1178e7660
```

The exit code is 0, because the resulting graph is correct; with `--strict-incremental` it is 5. In CI, analyze the base commit with `--untrusted` too (or keep a CI-only store) so that the commit-range sync can stay incremental. See [CI workflows](ci.md).

## What you lose without evaluation

Measured on the demo repository `contoso-orders` (four .NET projects, one of them an Aspire AppHost), comparing a trusted `analyze` with `analyze --untrusted`:

```bash
vogoban diff
```

```text
repository diff gs_86a8ab158612ca84b7c55d51 (474e594750ac) -> gs_84eca58655329ab1178e7660 (474e594750ac)  repository contoso-orders
entities: +0 -6 ~4   relationships: +0 -45 ~18
category        added  removed  changed
--------------  -----  -------  -------
INFRASTRUCTURE  0      6        0
PROJECT         0      0        4
```

What changed:

- The six Aspire resources declared in the AppHost (`aspire:messaging`, `aspire:orders`, `aspire:billing`, `aspire:cosmos`, `aspire:ordersdb`, `aspire:orderdocs`) disappeared. Aspire generates the `Projects.*` metadata types through SDK targets; without evaluation the AppHost does not compile cleanly (`compilation errors=1` instead of `errors=0`) and its builder calls cannot be bound.
- The 45 removed relationships are the AppHost's calls into the Aspire APIs (`CALLS`, `USES_TYPE`, `DECLARES`, `ASSEMBLY_REFERENCES`) and the edges of the Aspire resources (`CREATES`, `CONTAINS_RESOURCE`, `DECLARED_BY`, `CONNECTS_TO`).
- `PACKAGE_DEPENDS_ON` relationships were downgraded from evidence `EXACT` to `DECLARED`.
- Each `Project` entity's `projectEvaluation` changed from `msbuild` to `static`.

No service, API, message or code entity outside the AppHost changed in this repository. The loss depends on how much a repository relies on SDK logic, `Directory.Build.*` files, conditional items and generated sources. The Phase 15 release gate measured 6,658 entities for jailed analysis of dotnet/eShop without network for restore, against 7,298 for trusted local analysis ([report](../release/release-gate-phase15.md)).

## Platform worker modes

The platform worker never analyzes inline: it runs `analyze` in a child process wrapped according to a sandbox plan decided by `src/platform/sandbox.ts`. The plan is chosen once per worker process, on its first analysis job, and logged as `sandbox.plan`:

```text
{"ts":"…","level":"info","event":"sandbox.plan","component":"sandbox","mode":"namespace-jail","reason":"user+mount+net namespace jail"}
```

| Mode | When | Guarantees | Cost |
|---|---|---|---|
| `namespace-jail` | The probe succeeds: unprivileged user, mount, PID and network namespaces, a tmpfs root, a private `/proc` and `pivot_root` all work. | Analysis (and MSBuild evaluation) sees only the toolchain directories (`/usr`, `/bin`, `/lib*`, `/opt`), the application and .NET SDK (read-only), the tenant's own NuGet root and the tenant directory. No network. Other tenants, host secrets, `/home` and the platform database are invisible. | Full fidelity, except that packages cannot be downloaded inside the jail; restore must already be in the tenant NuGet root. |
| `static-only` | No jail is possible and `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES` is not `1`. | `VOGOBAN_MSBUILD_EVALUATION=0`: no repository build logic runs. | Reduced fidelity, as described above. A `static` project evaluation in this mode is expected, not a failure. |
| `trusted-unconfined` | No jail is possible and `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1`. | None beyond the environment allowlist and per-tenant NuGet/HOME. A warning `sandbox.trusted` is logged. | Full fidelity; only acceptable if every repository on the platform is trusted. |

In every mode the analyzer gets a reduced environment (toolchain, locale, `DOTNET_*`, `NUGET_*`, `MSBUILD*` and the correlation ids; never platform or provider secrets), a per-tenant NuGet root at `<tenant dir>/.nuget`, and `HOME`/`DOTNET_CLI_HOME` set to the tenant directory, so no tenant shares a package cache or profile with another. Files outside the repository, symbolic links and non-regular files are rejected by the Roslyn analyzer in every mode.

Under Docker's default profile the jail is not possible and the worker runs `static-only`. To allow it, run the worker with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`, as the reference `deploy/docker-compose.yml` does. Relaxing seccomp and AppArmor alone is not enough, because Docker's masked `/proc` paths forbid mounting a new procfs. Kubernetes was not validated. Details: [Enterprise platform](enterprise.md#analysis-isolation).

## Limitations

- The CLI never confines analysis. `--untrusted` prevents repository build logic from running, but the analyzer still reads the repository as your user.
- A trusted CLI run executes MSBuild evaluation with your user's permissions and environment.
- `dotnet restore`, if you run it, evaluates the repository's build files regardless of Vogoban's mode.
- The platform probe result is cached for the lifetime of the worker process; restart the worker after changing its container security options.

## Related

- [Analyzing real repositories](repository-analysis.md)
- [CI workflows](ci.md)
- [Enterprise platform](enterprise.md)
- [Security model](../architecture/security-model.md)
- [`graph sync`](../cli/sync.md)

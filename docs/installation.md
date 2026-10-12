# Installation

Vogoban 0.18.0 is a command-line tool called `vogoban`. It runs on [Bun](https://bun.sh) and is distributed as a source package (`vogoban-0.18.0-src.tar.gz`) and as a container image you build from that package. It is **not published to the npm registry**, so `npm install -g vogoban` does not work.

## Requirements

| Requirement | Needed for | Notes |
|---|---|---|
| Linux x86_64 | everything | Validated on Ubuntu 24.04. Windows is not supported or validated: use WSL2 or the container image. macOS has not been validated. |
| Bun ≥ 1.3 | everything | Validated with Bun 1.3.14. Vogoban ships its own TypeScript compiler, so no Node.js or npm is needed. |
| Git | reading commits, change detection | A plain directory without Git can still be analyzed, but it has no commit and no change tracking. |
| .NET SDK 8 or later | full C# semantic analysis (optional) | Found as `dotnet` on `PATH`, `~/.dotnet/dotnet`, or the path in `VOGOBAN_DOTNET`. Without it, C# is analyzed from syntax only. |
| Docker | only for the container image | |

Analyzing TypeScript or JavaScript does **not** need Node.js, npm or the repository's `node_modules`.

## Install with Bun (recommended)

1. Install Bun if you do not have it. See [bun.sh](https://bun.sh) for the installer, then check the version:

   ```bash
   bun --version
   ```

2. Install Vogoban globally from the source package:

   ```bash
   bun install -g ./vogoban-0.18.0-src.tar.gz
   ```

   Expected output ends like this. The blocked postinstall scripts belong to native Tree-sitter packages that Vogoban does not use (it uses the WebAssembly parsers), so you can ignore the message:

   ```text
   32 packages installed [248.00ms]

   Blocked 3 postinstalls. Run `bun pm -g untrusted` for details.
   ```

3. Make sure Bun's global bin directory is on your `PATH`. Bun installs the `vogoban` command into `~/.bun/bin`:

   ```bash
   export PATH="$HOME/.bun/bin:$PATH"   # add this line to ~/.bashrc or ~/.zshrc
   ```

4. Verify:

   ```bash
   vogoban --version
   ```

   ```text
   0.18.0
   ```

If you have an unpacked copy of the source instead of the archive, `bun install -g /path/to/vogoban` also works. In that case the installed command links to that directory, so keep the directory where it is.

### Upgrade and uninstall

Install a newer archive the same way to upgrade. To remove Vogoban:

```bash
bun remove -g vogoban
```

Your graph stores (`.vogoban/graph.db` files) are not touched by either operation.

## Enable C# semantic analysis

Vogoban understands C# best when the .NET SDK is available, because it then compiles every project with Roslyn (the C# compiler platform) and records compiler-resolved facts: real call targets, resolved types, overrides, DI registrations and so on.

```bash
dotnet --list-sdks     # any 8.x or newer SDK
```

- The first semantic analysis builds Vogoban's Roslyn analyzer (`semantic/Vogoban.Roslyn`) automatically. That build restores NuGet packages, so it needs network access once. It is rebuilt only when its sources change.
- If `dotnet` is not on `PATH`, point Vogoban at it: `export VOGOBAN_DOTNET=/opt/dotnet/dotnet`.
- Restore the repository you analyze (`dotnet restore`) for full resolution of NuGet types. Vogoban reads `obj/project.assets.json`; packages that are not restored show up as `missing-package` unresolved references instead of guessed relationships.

Without the SDK, analysis still works: C# declarations come from Tree-sitter (a syntax parser) and the graph records a `semantic-unavailable` diagnostic. You can request this mode explicitly with `vogoban analyze . --no-semantic`.

## Run in a container

Build the image from the unpacked source package. The image contains Bun, Git, the .NET SDKs (9 and 10) and a prebuilt Roslyn analyzer:

```bash
tar xzf vogoban-0.18.0-src.tar.gz     # unpacks into ./v
cd v
docker build -t vogoban:0.18.0 .
docker run --rm vogoban:0.18.0 --version
```

The image's entrypoint is the `vogoban` CLI and its default command is `platform serve` (the enterprise server), so always pass a command. To analyze a repository from your machine:

```bash
cd my-project
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/src/my-project" \
  -e VOGOBAN_DB=/src/my-project/.vogoban/graph.db \
  vogoban:0.18.0 analyze /src/my-project
```

Three details matter here, all verified with the 0.18.0 image:

- **Run as the repository owner** (`--user "$(id -u):$(id -g)"`). Otherwise Git refuses to read the mounted repository and Vogoban stops with `Git refuses to read /src/my-project because it is owned by a different user (dubious ownership)`. Vogoban does not override this Git safety check.
- **Put the store somewhere that user can write.** The image default is `VOGOBAN_DB=/data/graph.db`, owned by the image's own user (uid 10001), so with `--user` you set `VOGOBAN_DB` to a path in your mount.
- **Do not pass `-w`/`--workdir`.** The entrypoint runs from `/app`; changing the working directory breaks it (`error: Module not found "src/cli/main.ts"`).

The repository is named after the mounted directory (`my-project` above), which is why the example mounts it under its own name.

## Check the installation

```bash
vogoban --help      # the full command list
vogoban privacy     # where data is stored and what, if anything, leaves the machine
```

`vogoban privacy` on a fresh installation reports local mode, no telemetry and no outbound network:

```text
Operating mode: LOCAL
Telemetry: OFF (none implemented; no vendor endpoint exists in this product)
Phone-home: none  ·  update checks: none  ·  crash reporting: none  ·  license heartbeat: none
Storage: local sqlite at .vogoban/graph.db (architecture data stays local)
…
```

## Next steps

- [Getting started](getting-started.md): analyze your first repository.
- [Five-minute quickstart](quickstart.md): a copy-paste tour on the bundled sample.
- [Troubleshooting](advanced/troubleshooting.md): `dotnet` not found, Git ownership errors and more.

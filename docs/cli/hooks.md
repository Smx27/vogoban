# Git hook commands

`vogoban hooks` installs, removes and reports optional Git hooks that keep the graph current after commits and merges. Hooks are a thin adapter over [`graph sync`](sync.md): they run the same engine as the CLI and CI. They are never required, never change your Git configuration, and never block or fail a commit.

## What gets installed

`hooks install` writes two hook scripts into the repository's hooks directory (`git rev-parse --git-path hooks`, normally `.git/hooks`):

- `post-commit`
- `post-merge`

Each script is marked with a sentinel line (`# vogoban-incremental-sync-hook`) so Vogoban only ever touches its own hooks. What the script does depends on `--hook-mode`:

| Mode | Behaviour | Commit speed |
| --- | --- | --- |
| `notify` (default) | Prints a reminder to run `graph sync`. | Unchanged |
| `background` | Starts `vogoban graph sync --quiet` detached and returns immediately. | Unchanged |
| `sync` | Runs `vogoban graph sync --quiet` and waits for it. | Commit returns after the sync |

Every hook exits 0: a missing binary, a recursive invocation (`VOGOBAN_HOOK_RUNNING`) or a failed sync is ignored. Check `vogoban graph history` to see what hook-triggered syncs did.

## hooks install

### What it does

Installs the two hooks in the given repository (default `.`). An existing vogoban hook is replaced. An existing hook that is not a vogoban hook is skipped unless you pass `--force`, in which case it is saved as `<hook>.vogoban-backup` and restored by `hooks uninstall`.

### Usage

```bash
vogoban hooks install [path] [--hook-mode notify|background|sync] [--force] [--db <path>]
```

| Option | Meaning |
| --- | --- |
| `--hook-mode` | `notify` (default), `background` or `sync`. Any other value exits 2. |
| `--force` | Replace a non-vogoban hook (it is backed up first). |
| `--db <path>` | Bake this store into the hook as an absolute path. |

Two settings are baked into the script at install time:

- **The command.** The hook calls `vogoban` from `PATH`, or the value of `VOGOBAN_BIN` if it was set when you ran `hooks install`. Set it when Git runs hooks with a different `PATH` (GUI clients, IDEs), for example `VOGOBAN_BIN=$HOME/.bun/bin/vogoban`.
- **The store.** With `--db`, the hook passes `--db <absolute path>` to `graph sync`, so it updates that store whatever directory Git runs it from. Without `--db`, the hook uses the default store, which Git hooks resolve relative to the repository root (`./.vogoban/graph.db`) unless `VOGOBAN_DB` is set in the environment of the commit.

### Example

```bash
vogoban hooks install
```

### Output

```text
Git hooks (notify) using command 'vogoban':
  post-commit: installed
  post-merge: installed
```

The installed `post-commit`:

```bash
#!/bin/sh
# vogoban-incremental-sync-hook
# mode: notify
# Remove with: vogoban hooks uninstall
# Never blocks or fails a commit: absent binary, recursion, and sync errors are ignored.
[ -n "$VOGOBAN_HOOK_RUNNING" ] && exit 0
command -v 'vogoban' >/dev/null 2>&1 || exit 0
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX
export VOGOBAN_HOOK_RUNNING=1
echo "vogoban: repository changed - run 'vogoban graph sync' to update the architecture graph." || true
exit 0
```

Synchronous hooks with a baked-in store:

```bash
vogoban hooks install --hook-mode sync --db .vogoban/graph.db
```

```text
Git hooks (sync) using command 'vogoban':
  post-commit: installed
  post-merge: installed
```

The hook body now ends with:

```bash
# graph store: /home/user/.capy/work/scratch/cli2/demo/contoso-orders/.vogoban/graph.db
…
'vogoban' graph sync --quiet --db '/home/user/.capy/work/scratch/cli2/demo/contoso-orders/.vogoban/graph.db' || true
```

After a commit with a `sync` hook installed, `graph history` shows the run:

```bash
VOGOBAN_BIN=$HOME/.bun/bin/vogoban vogoban hooks install --hook-mode sync
git commit -am "Add note"
vogoban graph history --limit 3
```

```text
timestamp                 mode         status   commit        files  ms    fallback
------------------------  -----------  -------  ------------  -----  ----  --------
2026-10-11T17:09:26.341Z  incremental  SUCCESS  fbe23c1098fd  1      2032
…
```

An existing non-vogoban hook is protected:

```bash
vogoban hooks install --hook-mode background
```

```text
Git hooks (background) using command 'vogoban':
  post-commit: installed
  post-merge: skipped (a non-vogoban hook already exists; pass --force to overwrite)
```

### Useful options

- `--hook-mode background` keeps commits fast while still updating the graph. Concurrent syncs of one repository are serialized by a lock, so rapid commits queue rather than corrupt the store.
- `--force` when you deliberately replace an existing hook; uninstall puts it back.

### Common mistakes

- Expecting a `post-checkout` hook. Only `post-commit` and `post-merge` are installed; after switching branches run `vogoban graph sync` yourself.
- Installing without `--db` while you normally use a store outside the repository. The hook then syncs `./.vogoban/graph.db` in the repository instead. Reinstall with `--db`.
- Every non-platform command opens the store eagerly, `hooks` included. `vogoban hooks install --db /some/path/graph.db` creates that store file if it does not exist.

## hooks status

### What it does

Reports whether each vogoban hook is installed and in which mode. `vogoban hooks` without a subcommand does the same.

### Usage

```bash
vogoban hooks status [path] [--json]
```

### Example

```bash
vogoban hooks status
```

### Output

```text
Git hook status:
  post-commit: installed (notify)
  post-merge: installed (notify)
```

A hook that exists but is not a vogoban hook is reported as `not installed`. `--json` returns `[{ "hook", "installed", "mode" }]`.

## hooks uninstall

### What it does

Removes the vogoban hooks and restores any hook that `--force` backed up. Hooks that are not vogoban hooks are left alone.

### Usage

```bash
vogoban hooks uninstall [path]
```

### Example

```bash
vogoban hooks uninstall
```

### Output

```text
Removed vogoban Git hooks:
  post-commit: removed
  post-merge: removed (previous hook restored)
```

Other possible results are `skipped (not installed)` and `skipped (not a vogoban hook)`.

## Related

- [sync.md](sync.md): what the hooks run
- [Incremental analysis](../features/incremental-analysis.md)
- [CI](../advanced/ci.md): commit-range sync in pipelines instead of hooks

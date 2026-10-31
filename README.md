# gitp

A desktop git client: commit graph, diffs, staging, branch and tag management,
interactive rebase, a conflict resolver, and an embedded terminal.

Built as a [Tauri](https://tauri.app) app — a Rust backend with a vanilla
TypeScript frontend, no framework.

```
crates/gitp-core   all git logic (libgit2 + the git CLI), frontend-agnostic
crates/gitp-gui    the Tauri app: commands, PTY, window
  └── webui        the frontend (TypeScript + Vite)
```

## Features

| Area | What you get |
|---|---|
| Repositories | Open, clone (branch, depth, single branch, submodules), init with a `.gitignore` template and default branch; repo tabs you can drag and rename; favorites on Cmd+1…9; local workspaces with bulk fetch / pull / open |
| Commit graph | Themes (Light, Dark, GitKraken, GitKraken Neon); WIP rows for this and every other worktree; stash nodes; hide / solo / pin branches; drag a branch onto another to merge, rebase, reset or push; branch hover fade and ghost branch; Author / Date / SHA columns you can hide and reorder; author filter; search by message, `author:`, `path:`, `content:` |
| Committing | Stage / unstage / discard by file, block or line (any text encoding); commit template, skip hooks, push after commit; amend; signing; stash with a message or staged only; Stash & Switch |
| Diffs | Unified / split, word diff, syntax highlighting, wrap, ignore whitespace, image diff, combined diff of a commit range, compare with the working directory, external diff / merge tools, patches out and in |
| History tools | Cherry-pick (one or an interactive multi-commit plan), revert, reset, interactive rebase, restore a file or revert a block from a commit, blame, file history, reflog, bisect, activity log |
| Conflicts | 3-way resolver for merge, rebase, cherry-pick, revert and squash merges; take ours / theirs with a check for hand edits |
| Undo / redo | One step for commits, resets (a hard reset's uncommitted work comes back), merges, checkouts, branch and tag changes, fast-forwards of any branch, staging, discards, file edits, patches, ignore and stop-tracking, stash save / pop / apply / rename / drop, and remote add / URL / rename — each refused when the repository has moved on since |
| Branches, tags, remotes | Annotated tags pushed to or deleted from any remote; merge with no-ff / ff-only / squash; add, rename and remove remotes; Git Flow (initialize, start, finish) with plain git; Git LFS track, fetch and pull |
| Worktrees | Add (also from a commit, tag or by dropping a branch), open as a tab, move, lock, prune with a dry run; changed-file and ahead/behind counts; a warning before removing one with unsaved work |
| GitHub | Pull requests through the `gh` CLI: list, view the conversation, checks and diff (with a folder tree of the changed files), check out (also into a new worktree), comment, reply, review and comment on a diff line; load a review file's findings (Markdown `### path:line` blocks or JSON) as draft comments, or generate them with your own review command (`claude -p --model opus --effort medium` by default) over the diff, then edit, approve or discard each and post the approved ones as one review; sign in from the app |
| Tools | Git hooks listed in Settings, each switched off and on or opened in the editor; in-app file editor with Markdown preview; terminal tabs; Quick Launch (Cmd+K); profiles with their own identity, settings and tabs; per-repo text encoding; zoom; auto-fetch |

## Requirements

| | |
|---|---|
| Rust | stable (built against 1.97) — [rustup](https://rustup.rs) |
| Node.js | 20 or newer, with npm |
| Xcode CLT | macOS only: `xcode-select --install` |
| git | on `PATH` — gitp shells out to it for rebase, cherry-pick, push and friends |
| gh | optional, for pull requests: `brew install gh` — sign in from Settings → Git or the Pull Requests section |
| git-lfs | optional, for LFS repositories: `brew install git-lfs` |

gitp also looks in `/opt/homebrew/bin` and `/usr/local/bin` for `git-lfs` and
`gh`, so they are found when the app is opened from Finder.

macOS is the supported platform today. The Rust side is portable, but the app
has only been built and run against macOS's system WebKit.

## Run the app

Install the frontend dependencies once:

```bash
npm --prefix crates/gitp-gui/webui install
```

Then start the app in development mode — this launches Vite and opens the native
window, with hot reload on frontend edits and a rebuild on Rust edits:

```bash
npm --prefix crates/gitp-gui/webui run tauri dev
```

The first run compiles the whole Rust dependency tree and takes a few minutes;
subsequent runs are fast.

## Build the app

```bash
npm --prefix crates/gitp-gui/webui run tauri build
```

This type-checks and bundles the frontend (`tsc && vite build`), compiles the
Rust binary in release mode, then packages it as a macOS app and a disk image:

```
target/release/bundle/macos/gitp.app
target/release/bundle/dmg/gitp_0.1.0_aarch64.dmg   # _x64 on an Intel Mac
```

**Install** by opening the `.dmg` and dragging `gitp.app` onto the
`Applications` shortcut — or copy the app straight from the build:

```bash
cp -R target/release/bundle/macos/gitp.app /Applications/
```

> **The app is not notarized.** It is ad-hoc signed (`signingIdentity: "-"` in
> [`crates/gitp-gui/tauri.conf.json`](crates/gitp-gui/tauri.conf.json)), which
> is enough to run a build you made yourself. A build downloaded from a GitHub
> Release is quarantined, and Gatekeeper will refuse to open it with a
> "can't be checked for malicious software" message. Right-click the app →
> **Open** once to allow it, or clear the quarantine flag:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/gitp.app
> ```

**Run directly**, without installing: the bare executable is built alongside
the bundle.

```bash
./target/release/gitp-gui
```

**Releases.** Pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds a
universal (Apple silicon + Intel) `.dmg` and a zipped `gitp.app` and attaches
them to a GitHub Release for that tag.

## Uninstall

Nothing outside the app bundle is installed — no launch agent, no helper, no
login item. Removing gitp means deleting the app, its data, and what a build
left behind.

**The app**, if you installed it:

```bash
rm -rf /Applications/gitp.app
```

**Build output** (the bulk of it — the Rust target directory runs to several GB):

```bash
cargo clean
rm -rf crates/gitp-gui/webui/node_modules crates/gitp-gui/webui/dist
```

**Per-user application data.** Written only once the app has actually run, and
only some of these will exist. They hold the WebKit profile backing gitp's
preferences — theme, open repository tabs, recent repositories, pane sizes, the
default pull method:

```bash
rm -rf ~/Library/Application\ Support/io.gitp.desktop
rm -rf ~/Library/Caches/io.gitp.desktop
rm -rf ~/Library/WebKit/io.gitp.desktop
rm -rf ~/Library/Saved\ Application\ State/io.gitp.desktop.savedState
```

`io.gitp.desktop` is the bundle identifier from `tauri.conf.json`; change it
there and these paths change with it. Running the bare `gitp-gui` executable
(or `tauri dev`) has no bundle, so WebKit files its data under the executable
name instead:

```bash
rm -rf ~/Library/Caches/gitp-gui
rm -rf ~/Library/WebKit/gitp-gui
```

**Dotfile backups.** Applying a dotfile template saves each file it overwrites
next to the original as `~/<name>.bak-YYYYMMDD-HHMMSS` (e.g.
`~/.gitconfig.bak-20261017-080910`). gitp never deletes these; remove them by
hand once you no longer need them.

Finally, delete the repository clone itself. None of this touches the git
repositories gitp has opened — gitp only ever reads and writes them through git.

## Tests

```bash
cargo test                                        # Rust: gitp-core + gitp-gui
npm --prefix crates/gitp-gui/webui test           # frontend unit tests (Vitest)
npm --prefix crates/gitp-gui/webui run typecheck   # type-check only
```

CI also runs `cargo fmt --all --check` and
`cargo clippy --workspace --all-targets -- -D warnings`.

**Large-repository timings** are opt-in. Generate a test repository (100k
commits, hundreds of branches and tags) in an empty folder:

```bash
git init -q -b main big && cd big && python3 ../scripts/gen-large-repo.py 100000 10000 | git fast-import --quiet
```

then:

```bash
GITP_BENCH_REPO=/path/to/big cargo test -p gitp-core --release --test large_repo_timing -- --ignored --nocapture
GITP_PERF=1 npm --prefix crates/gitp-gui/webui test -- large-repo-timing
```

The graph's first page comes from `git log` as it lists the history, so it is
quick only with a commit-graph (a fresh `git fast-import` or clone has none).
gitp writes one, as `git gc` would, after its first full read of a history of
5,000+ commits; `git commit-graph write --reachable` does the same by hand.

## Frontend-only development

The frontend runs standalone in an ordinary browser: `api.ts` falls back to mock
data whenever `window.__TAURI__` is absent, so UI work needs neither a Rust build
nor a real repository.

```bash
npm --prefix crates/gitp-gui/webui run dev        # http://localhost:5173
```

Every backed-by-git action is a no-op against fixtures in this mode, and the
status bar says so.

## Container stack

[`compose.yaml`](compose.yaml) runs the parts that *can* be containerised, the
same way on any machine. Works with `docker compose` and `podman compose` alike —
substitute whichever you have.

> **The desktop app is not one of them.** gitp links against macOS's system
> WebKit and opens a native window; a Linux container can neither produce that
> binary nor display it. The stack covers the frontend dev server and the
> `gitp-core` test suite. Build and run the app itself natively, as above.

**Frontend dev server** on <http://localhost:5173>, no Node installed on the host
required:

```bash
docker compose up webui
```

Edits on the host are picked up (the watcher polls, since inotify doesn't cross
the bind mount). Stop it with `docker compose down`.

**gitp-core's tests** on Linux, which is a useful check that nothing has drifted
into depending on macOS:

```bash
docker compose run --rm core
```

Override the command to run anything else in the same environment:

```bash
docker compose run --rm core cargo test -p gitp-core --test tag_ops
docker compose run --rm core cargo clippy -p gitp-core --all-targets
docker compose run --rm webui npm test
```

Both services keep their build caches in named volumes — `node_modules`,
`target/`, and the cargo registry — so the first run is slow and the rest are
not. The host's own `node_modules` and `target/` are deliberately shadowed:
they hold macOS-native binaries that cannot execute in a Linux container.

To reclaim the space those caches use:

```bash
docker compose down -v
```

### Behind a TLS-intercepting proxy

If your network terminates TLS with its own root CA (corporate proxies, Cloudflare
Zero Trust and similar), cargo inside the container will fail to reach crates.io:

```
error: failed to load source for dependency `git2`
  Caused by: [60] SSL peer certificate or SSH remote key was not OK
             (self-signed certificate in certificate chain)
```

The container doesn't trust that CA. Point cargo at it with a local override —
compose merges `compose.override.yaml` automatically, and it's gitignored, so
your certificate path stays out of the repository:

```yaml
# compose.override.yaml
services:
  core:
    volumes:
      - /absolute/path/to/your-root-ca.pem:/usr/local/share/ca-certificates/proxy-ca.crt:ro
    environment:
      CARGO_HTTP_CAINFO: /usr/local/share/ca-certificates/proxy-ca.crt
```

If npm hits the same wall, add `NODE_EXTRA_CA_CERTS` to the `webui` service the
same way. On macOS, `npm config get cafile` often already names the certificate.

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

## Requirements

| | |
|---|---|
| Rust | stable (built against 1.97) — [rustup](https://rustup.rs) |
| Node.js | 20 or newer, with npm |
| Xcode CLT | macOS only: `xcode-select --install` |
| git | on `PATH` — gitp shells out to it for rebase, cherry-pick, push and friends |

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

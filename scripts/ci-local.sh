#!/usr/bin/env bash
# Run what CI runs (.github/workflows/ci.yml, the "check" job), in the same
# order, so a red build shows here before a push. As on CI, a repository a test
# makes starts on `main` (init.defaultBranch), whatever this machine's git says.
#
#   scripts/ci-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
web=crates/gitp-gui/webui

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# The Rust tests make repositories through libgit2, which reads git's settings
# only from files: they get a home of their own whose .gitconfig takes in this
# machine's (identity, git-lfs) and then sets the default branch as CI does.
real_home=$HOME
ci_home=$(mktemp -d)
trap 'rm -rf "$ci_home"' EXIT
{
  for f in "$real_home/.gitconfig" "${XDG_CONFIG_HOME:-$real_home/.config}/git/config"; do
    [ -f "$f" ] && printf '[include]\n\tpath = %s\n' "$f"
  done
  printf '[init]\n\tdefaultBranch = main\n'
} > "$ci_home/.gitconfig"
export CARGO_HOME="${CARGO_HOME:-$real_home/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$real_home/.rustup}"
# shellcheck disable=SC1091
[ -f "$CARGO_HOME/env" ] && . "$CARGO_HOME/env"

if [ ! -d "$web/node_modules" ]; then
  step "Install frontend dependencies"
  npm --prefix "$web" ci
fi
step "Typecheck frontend"; npm --prefix "$web" run typecheck
step "Lint frontend";      npm --prefix "$web" run lint
step "Test frontend";      npm --prefix "$web" test
step "Build frontend";     npm --prefix "$web" run build
step "Check formatting";   cargo fmt --all --check
step "Clippy";             cargo clippy --workspace --all-targets -- -D warnings
step "Test Rust";          HOME="$ci_home" cargo test --workspace

printf '\n\033[1mAll CI steps passed.\033[0m\n'

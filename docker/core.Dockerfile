# Build/test image for the Rust side of the workspace.
#
# Only gitp-core is exercised here — see compose.yaml for why gitp-gui isn't.
FROM rust:1-bookworm

# `git` is a genuine runtime dependency of gitp-core, not a convenience: the
# write operations (cherry-pick, revert, rebase, push, tag) shell out to the git
# CLI rather than reimplementing them on libgit2, and every fixture test drives a
# real repository. cmake/pkg-config/libssl are what git2's vendored libgit2 needs
# in order to build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      cmake \
      pkg-config \
      libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Fixtures create commits, and git refuses without an identity — a fresh image
# has no user config to fall back on.
RUN git config --global user.email "ci@gitp.invalid" \
 && git config --global user.name "gitp CI"

# Deliberately no `init.defaultBranch`: the fixtures name their initial branch
# explicitly, and setting it here would change what libgit2 creates for the
# git2-based fixtures (which expect `master`) while the shell-based ones use
# `main`. One global value cannot satisfy both.

WORKDIR /app

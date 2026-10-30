#!/usr/bin/env python3
"""Emit a `git fast-import` stream for a large synthetic history, for the
speed checks (crates/gitp-core/tests/large_repo_timing.rs and the ignored
timing test in crates/gitp-gui/src/history.rs). No network involved.

COMMITS commits (default 100k): a main line with feature branches that fork,
take a few commits and merge back, up to 30 open at a time; ~400 branches never
merged, each with a copy under refs/remotes/origin; a tag every 100 main
commits; 50 authors; FILES files in the tree (default 10k); and one 5000-line
file, src/big.c, edited every 400 main commits, for blame.

    mkdir big && cd big && git init -q -b main
    python3 gen-large-repo.py 100000 10000 | git fast-import --quiet
    git update-ref -d refs/heads/_scratch && git checkout -q -f main
    git pack-refs --all && git commit-graph write --reachable  # as after a gc

For a status check with thousands of changes, append a line to every other
file under src/ and add a couple of thousand untracked files.
"""
import random
import sys

random.seed(52)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000
NFILES = int(sys.argv[2]) if len(sys.argv) > 2 else 10_000
out = sys.stdout.buffer
AUTHORS = [(f"Dev {i}", f"dev{i}@example.com") for i in range(50)]
WORDS = "alpha beta gamma delta parse render cache graph lane index fetch merge fix add remove refactor".split()
t = 1_400_000_000
mark = 0
version = {}  # path -> version counter


def data(b):
    out.write(b"data %d\n" % len(b))
    out.write(b)
    out.write(b"\n")


def content(path, v):
    return "".join(f"{path} line {i} v{v if i % 7 == v % 7 else 0}\n" for i in range(20)).encode()


def big(v):
    return "".join(f"int f{i}(void) {{ return {i * (1 + (i % 400 == v % 400) * v)}; }}\n" for i in range(5000)).encode()


def commit(ref, parent, merge=None, files=(), msg=None, extra=None):
    global mark, t
    mark += 1
    t += random.randint(30, 600)
    name, email = random.choice(AUTHORS)
    out.write(b"commit %s\nmark :%d\n" % (ref.encode(), mark))
    out.write(f"author {name} <{email}> {t} +0000\ncommitter {name} <{email}> {t} +0000\n".encode())
    msg = msg or f"{random.choice(WORDS)} {random.choice(WORDS)} in {files[0] if files else 'tree'}\n\nBody #{mark}: {' '.join(random.choices(WORDS, k=12))}\n"
    data(msg.encode())
    if parent:
        out.write(b"from :%d\n" % parent)
    if merge:
        out.write(b"merge :%d\n" % merge)
    for p in files:
        version[p] = version.get(p, 0) + 1
        out.write(f"M 100644 inline {p}\n".encode())
        data(content(p, version[p]))
    for p, b in (extra or {}).items():
        out.write(f"M 100644 inline {p}\n".encode())
        data(b)
    return mark


paths = [f"src/mod{i // 100}/file{i}.rs" for i in range(NFILES)]
# Root: the whole tree at once.
mark += 1
out.write(b"commit refs/heads/main\nmark :1\n")
out.write(f"author Dev 0 <dev0@example.com> {t} +0000\ncommitter Dev 0 <dev0@example.com> {t} +0000\n".encode())
data(b"initial import\n")
for p in paths:
    version[p] = 0
    out.write(f"M 100644 inline {p}\n".encode())
    data(content(p, 0))
out.write(b"M 100644 inline src/big.c\n")
data(big(0))

main = 1
main_count = 0
open_br = {}  # name -> (tip mark, touched paths)
n_branch = 0
left = []
while mark < N:
    r = random.random()
    if r < 0.45 or (not open_br and r >= 0.55):
        main_count += 1
        extra = {"src/big.c": big(main_count)} if main_count % 400 == 0 else None
        main = commit("refs/heads/main", main, files=random.sample(paths, random.randint(1, 3)), extra=extra)
        if main_count % 100 == 0:
            out.write(f"reset refs/tags/v{main_count // 100}.0\nfrom :{main}\n".encode())
    elif r < 0.55 and len(open_br) < 30:
        n_branch += 1
        name = f"feature/{n_branch}-{random.choice(WORDS)}"
        fs = random.sample(paths, 3)[:1]  # (3: keeps the measured repo's random sequence)
        tip = commit("refs/heads/_scratch", main, files=fs)
        open_br[name] = (tip, set(fs))
    elif open_br and r < 0.9:
        name = random.choice(list(open_br))
        tip, touched = open_br[name]
        fs = random.sample(paths, random.randint(1, 2))
        open_br[name] = (commit("refs/heads/_scratch", tip, files=fs), touched | set(fs))
    elif open_br:
        name = random.choice(list(open_br))
        tip, touched = open_br.pop(name)
        if random.random() < 0.04 and len(left) < 400:
            left.append((name, tip))  # never merged: stays a branch
            continue
        # The merge carries the branch's files as last written there.
        extra = {p: content(p, version[p]) for p in touched}
        main = commit("refs/heads/main", main, merge=tip, extra=extra, msg=f"Merge branch '{name}'\n")
# Mirror a remote: every remaining branch also under refs/remotes/origin.
for name, tip in [(n, tm[0]) for n, tm in open_br.items()] + left + [("main", main)]:
    out.write(f"reset refs/heads/{name}\nfrom :{tip}\n\n".encode())
    out.write(f"reset refs/remotes/origin/{name}\nfrom :{tip}\n\n".encode())
out.write(b"done\n")
print(f"commits={mark} main={main_count} branches={len(open_br) + len(left)}", file=sys.stderr)

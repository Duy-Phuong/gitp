// The `.gitignore` starters Init Repository offers. Deliberately short — the
// build output and tool litter every project of that kind makes — rather than
// the exhaustive github/gitignore lists, which are easy to paste in later and
// hard to read through in a fresh repo.

export interface GitignoreTemplate {
  name: string;
  body: string;
}

export const GITIGNORE_TEMPLATES: GitignoreTemplate[] = [
  {
    name: "Node",
    body: "node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.local\nnpm-debug.log*\nyarn-error.log*\n",
  },
  { name: "Rust", body: "/target/\n**/*.rs.bk\n" },
  {
    name: "Python",
    body: "__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.env\n*.egg-info/\ndist/\nbuild/\n.pytest_cache/\n",
  },
  { name: "macOS", body: ".DS_Store\n.AppleDouble\n.LSOverride\n._*\n" },
];

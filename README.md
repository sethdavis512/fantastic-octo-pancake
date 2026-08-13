# fantastic-octo-pancake

A small collection of Bun Shell scripts.

## Setup

```sh
bun install
```

## Scripts

### `tools/repo-report.ts`

Emits a markdown snapshot of a git repository's recent activity: commit volume,
contributors, most-changed files, and least recently updated branches. Output
goes to stdout, so it pipes and redirects cleanly.

```sh
bun run repo-report                                    # last 30 days of the current repo
bun tools/repo-report.ts --since "2 weeks ago"         # narrower window
bun tools/repo-report.ts --repo ../other-project       # a different checkout
bun tools/repo-report.ts --frontmatter > report.md     # ready to drop into a notes vault
```

| Flag | Default | Description |
| --- | --- | --- |
| `--repo <path>` | current directory | Repository to inspect |
| `--since <date>` | `30 days ago` | Any git date expression |
| `--top <n>` | `10` | Rows per ranked section |
| `--frontmatter` | off | Prepend YAML frontmatter |
| `-h`, `--help` | | Show usage |

Exits `1` with a one-line message on a bad path or bad flag.

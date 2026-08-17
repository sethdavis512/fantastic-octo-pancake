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

### `tools/env-doctor.ts`

Finds environment variable drift before a deploy does. Scans source for env
references and diffs them against `.env.example` and `.env`, reporting three
buckets: **Missing** (referenced in code, absent from `.env`), **Undocumented**
(in `.env`, absent from `.env.example`), and **Stale** (in `.env.example`,
referenced nowhere).

```sh
bun run env-doctor                        # scan the current project
bun tools/env-doctor.ts --dir ../app
bun tools/env-doctor.ts --json            # machine-readable
bun tools/env-doctor.ts --strict          # exit 2 on any finding (CI gate)
```

| Flag | Default | Description |
| --- | --- | --- |
| `--dir <path>` | current directory | Project root to scan |
| `--example <path>` | `.env.example` | Reference file |
| `--env <path>` | `.env` | Actual file to check |
| `--ignore <name>` | | Key to exclude, repeatable |
| `--json` | off | JSON instead of markdown |
| `--strict` | off | Exit `2` when findings exist |
| `-h`, `--help` | | Show usage |

**It never prints a value.** Key names only, on every output path including
`--json`, so it is safe in CI logs and shared terminals.

Keys are scoped `server` or `client`, where `client` means a `VITE_` prefix that
gets inlined into the browser bundle. Exit codes are distinct on purpose: `1` is
a usage error, `2` is findings under `--strict`, so a typo'd flag can never read
as a clean gate.

Recognized reference forms: `process.env.KEY`, `process.env['KEY']`,
`import.meta.env.KEY`, `Bun.env.KEY`, and the bracketed variants. `node_modules`,
`.git`, `dist`, `build`, and `.react-router` are skipped.

#### What it holds back, and where

A few names are runtime-provided, so flagging them as Missing is pure noise:

| Key | Suppressed from Missing when |
| --- | --- |
| `NODE_ENV` | always |
| `MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL` | read via `import.meta.env` (Vite's built-ins) |

This suppression applies to the **Missing bucket only**. The same name sitting in
an env *file* is still reported, because it means someone wrote a value the
runtime is going to override. `BASE_URL` is gated on the reference form because
it is both a Vite built-in and a name real apps use for their own server-side
config; `process.env.BASE_URL` is your variable and gets reported normally.

Anything held back is named in the output, so a clean report is never
indistinguishable from a filtered one.

#### Known limitation

Whole-line `//` and block comments are stripped before matching, so env names in
documentation are not counted as references. Trailing `//` comments are
deliberately **not** stripped, because that would also eat `https://` inside
string literals on the same line. A key mentioned only in a trailing comment will
be reported as Missing. Use `--ignore` for it.

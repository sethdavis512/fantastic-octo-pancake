#!/usr/bin/env bun
/**
 * repo-report: emit a markdown snapshot of a git repository's recent activity.
 *
 * Usage:
 *   bun tools/repo-report.ts [--repo <path>] [--since <git-date>] [--top <n>] [--frontmatter]
 *
 * Writes markdown to stdout, so it pipes and redirects cleanly:
 *   bun tools/repo-report.ts --since "2 weeks ago" > report.md
 */

import { $ } from 'bun';

type Options = {
    repo: string;
    since: string;
    top: number;
    frontmatter: boolean;
};

type Contributor = {
    name: string;
    commits: number;
};

type ChurnEntry = {
    file: string;
    changes: number;
};

type Branch = {
    name: string;
    lastCommit: string;
    author: string;
};

function parseArgs(argv: string[]): Options {
    const options: Options = {
        repo: process.cwd(),
        since: '30 days ago',
        top: 10,
        frontmatter: false
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = () => {
            const value = argv[++index];
            if (value === undefined) {
                throw new Error(`Missing value for ${arg}`);
            }
            return value;
        };

        switch (arg) {
            case '--repo':
                options.repo = next();
                break;
            case '--since':
                options.since = next();
                break;
            case '--top': {
                const parsed = Number(next());
                if (!Number.isInteger(parsed) || parsed < 1) {
                    throw new Error('--top must be a positive integer');
                }
                options.top = parsed;
                break;
            }
            case '--frontmatter':
                options.frontmatter = true;
                break;
            case '--help':
            case '-h':
                console.log(
                    [
                        'repo-report: markdown snapshot of git activity',
                        '',
                        'Options:',
                        '  --repo <path>       repository to inspect (default: cwd)',
                        '  --since <date>      git date expression (default: "30 days ago")',
                        '  --top <n>           rows per ranked section (default: 10)',
                        '  --frontmatter       prepend YAML frontmatter for Obsidian',
                        '  -h, --help          show this message'
                    ].join('\n')
                );
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

async function assertGitRepo(repo: string) {
    const result = await $`git -C ${repo} rev-parse --is-inside-work-tree`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) {
        throw new Error(`Not a git repository: ${repo}`);
    }
}

function nonEmptyLines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

async function getRepoName(repo: string): Promise<string> {
    const remote = await $`git -C ${repo} remote get-url origin`.quiet().nothrow();

    if (remote.exitCode === 0) {
        const url = remote.stdout.toString().trim();
        const match = url.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
        if (match?.[1]) {
            return match[1];
        }
    }

    return repo.split('/').filter(Boolean).pop() ?? repo;
}

async function getCommitCount(repo: string, since: string): Promise<number> {
    const out = await $`git -C ${repo} rev-list --count --since=${since} HEAD`.text();
    return Number(out.trim());
}

async function getContributors(
    repo: string,
    since: string,
    top: number
): Promise<Contributor[]> {
    const out =
        await $`git -C ${repo} shortlog -sn --no-merges --since=${since} HEAD`
            .quiet()
            .text();

    return nonEmptyLines(out)
        .map((line) => {
            const [count, ...rest] = line.split('\t');
            return { name: rest.join('\t').trim(), commits: Number(count) };
        })
        .filter((entry) => entry.name.length > 0)
        .slice(0, top);
}

async function getChurn(
    repo: string,
    since: string,
    top: number
): Promise<ChurnEntry[]> {
    const out =
        await $`git -C ${repo} log --since=${since} --name-only --pretty=format: --no-merges`
            .quiet()
            .text();

    const counts = new Map<string, number>();
    for (const file of nonEmptyLines(out)) {
        counts.set(file, (counts.get(file) ?? 0) + 1);
    }

    return [...counts.entries()]
        .map(([file, changes]) => ({ file, changes }))
        .sort((a, b) => b.changes - a.changes || a.file.localeCompare(b.file))
        .slice(0, top);
}

async function getStaleBranches(repo: string, top: number): Promise<Branch[]> {
    const format = '%(refname:short)\t%(committerdate:short)\t%(authorname)';
    const out =
        await $`git -C ${repo} for-each-ref --sort=committerdate --format=${format} refs/heads`
            .quiet()
            .text();

    return nonEmptyLines(out)
        .map((line) => {
            const [name = '', lastCommit = '', author = ''] = line.split('\t');
            return { name, lastCommit, author };
        })
        .slice(0, top);
}

function table(headers: string[], rows: string[][]): string {
    if (rows.length === 0) {
        return '_No data for this window._';
    }

    const divider = headers.map(() => '---');
    return [headers, divider, ...rows]
        .map((cells) => `| ${cells.join(' | ')} |`)
        .join('\n');
}

async function buildReport(options: Options): Promise<string> {
    await assertGitRepo(options.repo);

    const [repoName, commitCount, contributors, churn, staleBranches] =
        await Promise.all([
            getRepoName(options.repo),
            getCommitCount(options.repo, options.since),
            getContributors(options.repo, options.since, options.top),
            getChurn(options.repo, options.since, options.top),
            getStaleBranches(options.repo, options.top)
        ]);

    const generatedAt = new Date().toISOString().slice(0, 10);
    const sections: string[] = [];

    if (options.frontmatter) {
        sections.push(
            [
                '---',
                `title: Repo report: ${repoName}`,
                `date: ${generatedAt}`,
                'tags: [repo-report, git]',
                '---'
            ].join('\n')
        );
    }

    sections.push(
        `# Repo report: ${repoName}`,
        `Window: commits since \`${options.since}\` (generated ${generatedAt})`,
        `## Summary\n\n- Commits in window: **${commitCount}**\n- Contributors in window: **${contributors.length}**\n- Local branches listed: **${staleBranches.length}**`,
        `## Contributors\n\n${table(
            ['Author', 'Commits'],
            contributors.map((entry) => [entry.name, String(entry.commits)])
        )}`,
        `## Most-changed files\n\n${table(
            ['File', 'Commits touching it'],
            churn.map((entry) => [`\`${entry.file}\``, String(entry.changes)])
        )}`,
        `## Least recently updated branches\n\n${table(
            ['Branch', 'Last commit', 'Author'],
            staleBranches.map((entry) => [
                `\`${entry.name}\``,
                entry.lastCommit,
                entry.author
            ])
        )}`
    );

    return sections.join('\n\n');
}

try {
    console.log(await buildReport(parseArgs(process.argv.slice(2))));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

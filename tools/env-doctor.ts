#!/usr/bin/env bun
/**
 * env-doctor: find environment variable drift before a deploy does.
 *
 * Compares the env vars referenced in source against `.env.example` and `.env`,
 * reporting three buckets:
 *   - Missing:      referenced in code, absent from `.env`
 *   - Undocumented: present in `.env`, absent from `.env.example`
 *   - Stale:        listed in `.env.example`, referenced nowhere
 *
 * Key names only. This script never reads, prints, or stores an env value, so
 * it is safe to run in CI and in shared terminals.
 *
 * Usage:
 *   bun tools/env-doctor.ts [--dir <path>] [--example <path>] [--env <path>]
 *                           [--ignore <name>]... [--json] [--strict]
 *
 * Exit codes: 0 clean, 1 usage error, 2 findings under --strict.
 */

import { $ } from 'bun';

type Options = {
    dir: string;
    example: string;
    env: string;
    ignore: Set<string>;
    json: boolean;
    strict: boolean;
};

type Scope = 'server' | 'client';

type Finding = {
    key: string;
    scope: Scope;
};

type Report = {
    dir: string;
    exampleFile: string;
    envFile: string;
    envFilePresent: boolean;
    exampleFilePresent: boolean;
    filesScanned: number;
    findings: {
        missing: Finding[];
        undocumented: Finding[];
        stale: Finding[];
    };
};

const USAGE_ERROR = 1;
const FINDINGS_ERROR = 2;

const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,mts}';

const SKIPPED_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.react-router',
    '.next',
    'coverage'
]);

/**
 * Matches process.env.KEY, process.env['KEY'], import.meta.env.KEY,
 * Bun.env.KEY, and the bracketed forms of each.
 */
const ENV_REFERENCE_PATTERNS = [
    /(?:process|Bun)\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:process|Bun)\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
    /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /import\.meta\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g
];

/**
 * Strips block comments and whole-line `//` comments so that env names written
 * in documentation are not reported as real references. Trailing `//` comments
 * are left alone, since stripping them would also eat `https://` inside string
 * literals on the same line.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Keys the runtime provides; flagging these as missing is noise. */
const BUILT_IN_KEYS = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        dir: process.cwd(),
        example: '.env.example',
        env: '.env',
        ignore: new Set(),
        json: false,
        strict: false
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = () => {
            const value = argv[++index];
            if (value === undefined) {
                throw new UsageError(`Missing value for ${arg}`);
            }
            return value;
        };

        switch (arg) {
            case '--dir':
                options.dir = next();
                break;
            case '--example':
                options.example = next();
                break;
            case '--env':
                options.env = next();
                break;
            case '--ignore':
                options.ignore.add(next());
                break;
            case '--json':
                options.json = true;
                break;
            case '--strict':
                options.strict = true;
                break;
            case '--help':
            case '-h':
                console.log(
                    [
                        'env-doctor: find env var drift before a deploy does',
                        '',
                        'Options:',
                        '  --dir <path>        project root to scan (default: cwd)',
                        '  --example <path>    reference file (default: .env.example)',
                        '  --env <path>        actual file to check (default: .env)',
                        '  --ignore <name>     key to exclude, repeatable',
                        '  --json              JSON instead of markdown',
                        '  --strict            exit 2 when findings exist',
                        '  -h, --help          show this message',
                        '',
                        'Reports key names only, never values.',
                        'Exit codes: 0 clean, 1 usage error, 2 findings under --strict.'
                    ].join('\n')
                );
                process.exit(0);
                break;
            default:
                throw new UsageError(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function scopeOf(key: string): Scope {
    return key.startsWith('VITE_') ? 'client' : 'server';
}

function isSkipped(relativePath: string): boolean {
    return relativePath
        .split('/')
        .some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

/**
 * Collects env var names referenced in source. Values are never read.
 */
async function collectReferencedKeys(
    dir: string
): Promise<{ keys: Set<string>; filesScanned: number }> {
    const glob = new Bun.Glob(SOURCE_GLOB);
    const keys = new Set<string>();
    let filesScanned = 0;

    for await (const relativePath of glob.scan({ cwd: dir, onlyFiles: true })) {
        if (isSkipped(relativePath)) {
            continue;
        }

        const source = stripComments(
            await Bun.file(`${dir}/${relativePath}`).text()
        );
        filesScanned++;

        for (const pattern of ENV_REFERENCE_PATTERNS) {
            pattern.lastIndex = 0;
            for (const match of source.matchAll(pattern)) {
                const key = match[1];
                if (key) {
                    keys.add(key);
                }
            }
        }
    }

    return { keys, filesScanned };
}

/**
 * Reads key names from an env file, tolerating `export ` prefixes, comments,
 * blank lines, and quoted values. Values are discarded, never returned.
 */
async function collectEnvFileKeys(
    path: string
): Promise<{ keys: Set<string>; present: boolean }> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return { keys: new Set(), present: false };
    }

    const keys = new Set<string>();
    const text = await file.text();

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (match?.[1]) {
            keys.add(match[1]);
        }
    }

    return { keys, present: true };
}

function toFindings(keys: Iterable<string>, ignore: Set<string>): Finding[] {
    return [...keys]
        .filter((key) => !ignore.has(key) && !BUILT_IN_KEYS.has(key))
        .map((key) => ({ key, scope: scopeOf(key) }))
        .sort(
            (a, b) =>
                a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key)
        );
}

function difference(left: Set<string>, right: Set<string>): string[] {
    return [...left].filter((key) => !right.has(key));
}

function table(findings: Finding[], emptyMessage: string): string {
    if (findings.length === 0) {
        return `_${emptyMessage}_`;
    }

    return [
        '| Key | Scope |',
        '| --- | --- |',
        ...findings.map((finding) => `| \`${finding.key}\` | ${finding.scope} |`)
    ].join('\n');
}

function renderMarkdown(report: Report): string {
    const { missing, undocumented, stale } = report.findings;
    const total = missing.length + undocumented.length + stale.length;
    const clientCount = [...missing, ...undocumented, ...stale].filter(
        (finding) => finding.scope === 'client'
    ).length;

    const sections = [
        '# env-doctor',
        `Scanned ${report.filesScanned} source file(s) in \`${report.dir}\``,
        [
            '## Summary',
            '',
            `- Findings: **${total}**`,
            `- Missing: **${missing.length}** | Undocumented: **${undocumented.length}** | Stale: **${stale.length}**`,
            `- Client-exposed (\`VITE_\`) among findings: **${clientCount}**`,
            `- \`${report.envFile}\`: ${report.envFilePresent ? 'found' : '**not found**, all referenced keys count as missing'}`,
            `- \`${report.exampleFile}\`: ${report.exampleFilePresent ? 'found' : '**not found**'}`
        ].join('\n'),
        [
            `## Missing (referenced in code, absent from \`${report.envFile}\`)`,
            '',
            table(missing, 'Nothing missing.')
        ].join('\n'),
        [
            `## Undocumented (in \`${report.envFile}\`, absent from \`${report.exampleFile}\`)`,
            '',
            table(undocumented, 'Nothing undocumented.')
        ].join('\n'),
        [
            `## Stale (in \`${report.exampleFile}\`, referenced nowhere)`,
            '',
            table(stale, 'Nothing stale.')
        ].join('\n')
    ];

    if (clientCount > 0) {
        sections.push(
            '> `client` scope means a `VITE_` key, which is inlined into the browser bundle. Never put a secret behind that prefix.'
        );
    }

    return sections.join('\n\n');
}

async function buildReport(options: Options): Promise<Report> {
    const dirExists = await $`test -d ${options.dir}`.quiet().nothrow();
    if (dirExists.exitCode !== 0) {
        throw new UsageError(`Not a directory: ${options.dir}`);
    }

    const resolve = (path: string) =>
        path.startsWith('/') ? path : `${options.dir}/${path}`;

    const examplePath = resolve(options.example);
    const envPath = resolve(options.env);

    const [referenced, exampleFile, envFile] = await Promise.all([
        collectReferencedKeys(options.dir),
        collectEnvFileKeys(examplePath),
        collectEnvFileKeys(envPath)
    ]);

    return {
        dir: options.dir,
        exampleFile: options.example,
        envFile: options.env,
        envFilePresent: envFile.present,
        exampleFilePresent: exampleFile.present,
        filesScanned: referenced.filesScanned,
        findings: {
            missing: toFindings(
                difference(referenced.keys, envFile.keys),
                options.ignore
            ),
            undocumented: toFindings(
                difference(envFile.keys, exampleFile.keys),
                options.ignore
            ),
            stale: toFindings(
                difference(exampleFile.keys, referenced.keys),
                options.ignore
            )
        }
    };
}

try {
    const options = parseArgs(process.argv.slice(2));
    const report = await buildReport(options);

    console.log(
        options.json
            ? JSON.stringify(report, null, 2)
            : renderMarkdown(report)
    );

    const total =
        report.findings.missing.length +
        report.findings.undocumented.length +
        report.findings.stale.length;

    if (options.strict && total > 0) {
        process.exit(FINDINGS_ERROR);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(USAGE_ERROR);
}

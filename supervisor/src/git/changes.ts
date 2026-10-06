import { execFile, execFileSync } from 'node:child_process'

/**
 * What a task changed in its project's checkout, recorded on the task
 * (`tasks.git`): where it started, and at the end the branch, the range
 * `base..head` and its size. The range stays reviewable after the checkout
 * moves on, as long as the commits exist.
 */
export interface TaskGit {
    /** HEAD and branch when the task started. */
    start_head: string
    start_branch: string | null
    /** Filled when the task ends. */
    branch?: string | null
    head?: string
    /** Where the changes start: the merge-base with the default branch for a task branch, else `start_head`. */
    base?: string
    /** The repository's default branch without the remote ("main"), the PR's base. */
    default_branch?: string | null
    files?: number
    added?: number
    removed?: number
    /** Changed files not committed at the end (the panel shows committed work only). */
    uncommitted?: number
    /** An open or merged pull request of the branch, when `gh` found one. */
    pr?: PullRequest | null
}

export interface PullRequest {
    number: number
    url: string
    state: string
    title: string
    isDraft?: boolean
}

export interface ChangedFile {
    path: string
    /** The old path of a rename or copy. */
    from?: string
    /** A added, M modified, D deleted, R renamed, C copied, T type changed. */
    status: string
    added: number
    removed: number
    binary: boolean
    /** Lock files, build output, minified bundles, snapshots: folded into one line by default. */
    generated: boolean
}

const MAX_PATCH_BYTES = 400 * 1024

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, env, timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`))
            else resolve(stdout)
        })
    })
}

const GENERATED = [
    /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|bun\.lockb?|composer\.lock|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|mix\.lock|pubspec\.lock)$/,
    /(^|\/)(dist|build|out|coverage|vendor|node_modules|\.next|\.nuxt|__generated__|generated)\//,
    /\.(min\.(js|css)|map|snap)$/,
    /(^|\/)__snapshots__\//,
    /\.(pb\.go|g\.dart|generated\.\w+)$/
]

export const isGenerated = (file: string) => GENERATED.some((re) => re.test(file))

/** HEAD and the branch of a checkout, or null when it is not a git repository (or has no commit yet). */
export async function snapshot(cwd: string): Promise<{ head: string; branch: string | null } | null> {
    try {
        const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
        const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        return { head, branch: branch === 'HEAD' ? null : branch }
    } catch {
        return null
    }
}

/**
 * The same, synchronously: taken when a task starts, before its CLI is
 * registered as running, where an await would let the worker start one
 * session too many. Two `rev-parse` calls take milliseconds.
 */
export function snapshotSync(cwd: string): { head: string; branch: string | null } | null {
    try {
        const out = execFileSync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const [head, branch] = out.trim().split('\n')
        return head ? { head, branch: !branch || branch === 'HEAD' ? null : branch } : null
    } catch {
        return null
    }
}

/** The default branch as a ref to diff against ("origin/main") and its short name ("main"), or null. */
async function defaultBranch(cwd: string): Promise<{ ref: string; name: string } | null> {
    try {
        const ref = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
        if (ref) return { ref, name: ref.replace(/^origin\//, '') }
    } catch {
        // no origin/HEAD (a clone made without it): try the usual names
    }
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
        try {
            await git(cwd, ['rev-parse', '--verify', '--quiet', ref])
            return { ref, name: ref.replace(/^origin\//, '') }
        } catch {
            // next
        }
    }
    return null
}

/**
 * The task's changes at its end. A task that made a branch is compared with
 * the default branch (everything on the branch, as the PR will show it); a
 * task that stayed on the default branch, or on a branch it found, with
 * where it started.
 */
export async function measure(cwd: string, start: Pick<TaskGit, 'start_head' | 'start_branch'>): Promise<TaskGit> {
    const now = await snapshot(cwd)
    if (!now) return { ...start }
    const main = await defaultBranch(cwd)
    let base = start.start_head
    if (main && now.branch && now.branch !== main.name && now.branch !== start.start_branch) {
        try {
            base = (await git(cwd, ['merge-base', main.ref, now.head])).trim() || base
        } catch {
            // unrelated histories: keep the start
        }
    }
    const files = await listFiles(cwd, base, now.head)
    let uncommitted = 0
    try {
        uncommitted = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean).length
    } catch {
        // leave 0
    }
    return {
        ...start,
        branch: now.branch,
        head: now.head,
        base,
        default_branch: main?.name ?? null,
        files: files.length,
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
        uncommitted
    }
}

/** Every file changed in `base..head`, with line counts; renames followed. */
export async function listFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]> {
    if (base === head) return []
    const [numstat, names] = await Promise.all([git(cwd, ['diff', '--numstat', '-M', '-z', base, head]), git(cwd, ['diff', '--name-status', '-M', '-z', base, head])])
    // --name-status -z: STATUS \0 path \0 (or STATUS \0 from \0 to \0 for R / C)
    const status = new Map<string, { status: string; from?: string }>()
    const parts = names.split('\0')
    for (let i = 0; i < parts.length && parts[i]; ) {
        const code = parts[i]
        if (code.startsWith('R') || code.startsWith('C')) {
            status.set(parts[i + 2], { status: code[0], from: parts[i + 1] })
            i += 3
        } else {
            status.set(parts[i + 1], { status: code[0] })
            i += 2
        }
    }
    // --numstat -z: "added\tremoved\tpath\0", or "added\tremoved\t\0from\0to\0" for a rename
    const files: ChangedFile[] = []
    const fields = numstat.split('\0')
    for (let i = 0; i < fields.length && fields[i]; ) {
        const [added, removed, inline] = fields[i].split('\t')
        let file = inline
        let from: string | undefined
        if (!inline) {
            from = fields[i + 1]
            file = fields[i + 2]
            i += 3
        } else {
            i += 1
        }
        const binary = added === '-'
        const known = status.get(file)
        files.push({
            path: file,
            from: from ?? known?.from,
            status: known?.status ?? 'M',
            added: binary ? 0 : Number(added) || 0,
            removed: binary ? 0 : Number(removed) || 0,
            binary,
            generated: isGenerated(file)
        })
    }
    return files
}

/** The unified diff of one file in `base..head`, cut at a size a phone can show. */
export async function filePatch(cwd: string, base: string, head: string, file: ChangedFile): Promise<{ patch: string; truncated: boolean }> {
    const paths = file.from ? [file.from, file.path] : [file.path]
    const patch = await git(cwd, ['diff', '-M', '--no-color', base, head, '--', ...paths])
    return patch.length > MAX_PATCH_BYTES ? { patch: patch.slice(0, MAX_PATCH_BYTES), truncated: true } : { patch, truncated: false }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { cwd, env, timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${command} ${args[0]}: ${stderr.trim() || error.message}`))
            else resolve(stdout)
        })
    })
}

/** The pull request whose head is this branch (open, else the latest), or null: no `gh`, no remote, none yet. */
export async function findPullRequest(cwd: string, branch: string, env: NodeJS.ProcessEnv): Promise<PullRequest | null> {
    try {
        const out = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state,title,isDraft'], cwd, env, 20_000)
        const list = JSON.parse(out) as PullRequest[]
        return list[0] ?? null
    } catch {
        return null
    }
}

/**
 * Push the task's branch and open a pull request against the default
 * branch, titled and described from the commits (`--fill`); an existing PR
 * of the branch is returned instead of a second one.
 */
export async function createPullRequest(cwd: string, branch: string, base: string, env: NodeJS.ProcessEnv): Promise<PullRequest> {
    const existing = await findPullRequest(cwd, branch, env)
    if (existing && existing.state === 'OPEN') return existing
    await run('git', ['push', '--set-upstream', 'origin', branch], cwd, env, 120_000)
    await run('gh', ['pr', 'create', '--head', branch, '--base', base, '--fill'], cwd, env)
    const created = await findPullRequest(cwd, branch, env)
    if (!created) throw new Error('gh created the pull request but cannot find it; look on GitHub')
    return created
}

/** "7 files, +210 −40", for Telegram and the chat. */
export function changesLine(g: TaskGit | null): string | null {
    if (!g?.files) return null
    return `${g.files} file${g.files === 1 ? '' : 's'}, +${g.added ?? 0} −${g.removed ?? 0}`
}

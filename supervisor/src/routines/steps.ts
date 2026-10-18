import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { type Item, parseItems, runSource, type SourceContext, SourceError } from './sources.js'
import type { RunStep, SourceStep, Step } from './spec.js'

/** What one script printed; `output` is capped so a chatty script cannot fill the prompt. */
export interface StepOutput {
    name: string
    output: string
    ms: number
    truncated: boolean
}

/** What a source step found: its current items, all of them (dedup is the scheduler's). */
export interface SourceResult {
    step: SourceStep
    items: Item[]
    ms: number
}

/** How one step went, for the run's row and the step's card: like a CI job's step. */
export interface StepResult {
    /** Its place in the pipeline, from 0. */
    index: number
    name: string
    kind: Exclude<Step['kind'], 'agent'>
    ok: boolean
    ms: number
    /** The head of what it printed (a script), or of its error; at most STEP_LOG_MAX. */
    log: string
    /** A source's item count. */
    items?: number
}

/** The pipeline up to the agent: the scripts' text and the sources' items, in the order the steps ran. */
export interface PipelineResult {
    outputs: StepOutput[]
    sources: SourceResult[]
    /** Every step that ran, in order. */
    steps: StepResult[]
    ms: number
}

export type StepContext = SourceContext

/** How much of a script's output reaches the prompt: the head and the tail of a long one. */
export const OUTPUT_MAX = 16_000
/** The most a script may print before it is cut off, so a runaway one cannot fill memory. */
const BUFFER_MAX = 8 << 20
/** After SIGTERM to the step's process group, how long before SIGKILL. */
const KILL_GRACE_MS = 5_000
/** How long the pipes may stay open after bash exits (a child in the background holds them). */
const DRAIN_MS = 500

/** How much of a step's output its result keeps for the run list. */
export const STEP_LOG_MAX = 2000

/** A step failed and the run stops: the message, and the steps that ran up to it (the failed one last). */
export class StepError extends Error {
    steps: StepResult[] = []
}

/** What one script did, whatever its exit code. */
export interface ScriptRun {
    stdout: string
    stderr: string
    /** The exit code; null when it was killed (timeout) or could not start. */
    code: number | null
    timedOut: boolean
    ms: number
}

/** The first and the last part of a long output, with a mark where it was cut. */
export function cap(output: string, max = OUTPUT_MAX): { text: string; truncated: boolean } {
    if (output.length <= max) return { text: output, truncated: false }
    const head = Math.floor(max * 0.7)
    const tail = max - head
    return {
        text: `${output.slice(0, head)}\n…[${output.length - max} characters cut]…\n${output.slice(-tail)}`,
        truncated: true
    }
}

/**
 * One script: `bash -c` in its own process group, so a timeout ends the whole
 * pipeline the script started (`curl | sort`, a loop of ssh calls), not only
 * bash. The routine's variables (`SKILL_DIR`, `ROUTINE_FILE`, …) are in the
 * environment: bash expands `${SKILL_DIR}` itself, safely inside quotes.
 */
export function runScript(step: RunStep, ctx: StepContext): Promise<ScriptRun> {
    const started = Date.now()
    const cwd = step.cwd ? path.resolve(ctx.cwd, step.cwd) : ctx.cwd
    return new Promise((resolve) => {
        if (!fs.existsSync(cwd))
            return resolve({
                stdout: '',
                stderr: `directory ${cwd} does not exist`,
                code: null,
                timedOut: false,
                ms: 0
            })
        const child = spawn('bash', ['-c', step.run], {
            cwd,
            env: ctx.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        let killed = false
        let settled = false
        const killGroup = (signal: NodeJS.Signals) => {
            try {
                process.kill(-child.pid!, signal)
            } catch {
                // already gone
            }
        }
        const timer = setTimeout(() => {
            killed = true
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref()
        }, step.timeout_s * 1000)
        // Decoded by the streams, so a character split between two chunks stays whole.
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            if (stdout.length < BUFFER_MAX) stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
            if (stderr.length < 64_000) stderr += chunk
        })
        const finish = (run: Omit<ScriptRun, 'ms'>) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ ...run, ms: Date.now() - started })
        }
        child.on('error', (error) =>
            finish({ stdout, stderr: `could not start: ${error.message}`, code: null, timedOut: false })
        )
        // `close` waits for stdio, which a child left in the background (`server &`) holds open:
        // once bash itself exits, the pipes get a moment to drain and the step ends without them.
        // Also after a timeout: a child that left the group (`setsid`) outlives the kill and keeps them open.
        child.on('exit', (code, signal) => {
            setTimeout(() => {
                if (settled) return
                child.stdout.destroy()
                child.stderr.destroy()
                child.emit('close', code, signal)
            }, DRAIN_MS).unref()
        })
        child.on('close', (code: number | null) => {
            if (killed) return finish({ stdout, stderr, code: null, timedOut: true })
            finish({ stdout, stderr, code, timedOut: false })
        })
    })
}

/** Why a script run counts as failed, or null when it exited 0. */
export function scriptFailure(step: RunStep, run: ScriptRun): string | null {
    if (run.timedOut) return `step "${step.name}" timed out after ${step.timeout_s} s`
    if (run.code === 0) return null
    const tail = (run.stderr || run.stdout).trim().split('\n').slice(-5).join('\n')
    return `step "${step.name}" ${run.code === null ? 'could not run' : `exited with ${run.code}`}${tail ? `: ${tail}` : ''}`
}

const head = (text: string) => (text.length > STEP_LOG_MAX ? `${text.slice(0, STEP_LOG_MAX)}…` : text)

/**
 * The routine's pipeline before the agent: every step in order, each in the
 * checkout (or its own `cwd`, relative to it) with the agent's environment
 * plus `ROUTINE`, `ROUTINE_FILE`, `PROJECT`, `PROJECT_DIR` and `SKILL_DIR`.
 * A script's output goes to the agent as text; a source's (a script with
 * `items`, GitHub, Trac) as items. A step that fails (non-zero exit, timeout,
 * a source that cannot reach its server) stops the run with its last lines,
 * before a single token is spent. The agent step is where the pipeline ends.
 */
export async function runPipeline(steps: Step[], ctx: StepContext): Promise<PipelineResult> {
    const started = Date.now()
    const result: PipelineResult = { outputs: [], sources: [], steps: [], ms: 0 }
    const fail = (message: string): never => {
        const error = new StepError(message)
        error.steps = result.steps
        throw error
    }
    for (const [index, step] of steps.entries()) {
        if (step.kind === 'agent') break
        const at = Date.now()
        if (step.kind === 'run') {
            const run = await runScript(step, ctx)
            const failure = scriptFailure(step, run)
            const done = (ok: boolean, log: string, items?: number) =>
                result.steps.push({ index, name: step.name, kind: step.kind, ok, ms: run.ms, log: head(log), items })
            if (failure) {
                done(false, [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n') || failure)
                fail(failure)
            }
            if (step.items) {
                try {
                    const items = parseItems(run.stdout)
                    result.sources.push({ step, items, ms: run.ms })
                    done(true, run.stdout, items.length)
                } catch (error) {
                    const message = `step "${step.name}": ${error instanceof Error ? error.message : String(error)}`
                    done(false, message)
                    fail(message)
                }
            } else {
                const { text, truncated } = cap(run.stdout)
                result.outputs.push({ name: step.name, output: text, ms: run.ms, truncated })
                done(true, run.stdout)
            }
            continue
        }
        try {
            const items = await runSource(step, ctx)
            const ms = Date.now() - at
            result.sources.push({ step, items, ms })
            result.steps.push({
                index,
                name: step.name,
                kind: step.kind,
                ok: true,
                ms,
                log: head(items.map((i) => i.title).join('\n')),
                items: items.length
            })
        } catch (error) {
            if (!(error instanceof SourceError)) throw error
            const message = `step "${step.name}": ${error.message}`
            result.steps.push({ index, name: step.name, kind: step.kind, ok: false, ms: Date.now() - at, log: message })
            fail(message)
        }
    }
    result.ms = Date.now() - started
    return result
}

/** What "Run this step" shows: one step alone, its whole output, its exit code; nothing is recorded. */
export interface SingleStepRun {
    kind: Exclude<Step['kind'], 'agent'>
    ok: boolean
    ms: number
    stdout: string
    stderr: string
    code: number | null
    timed_out: boolean
    /** A source's items (a script with `items`, GitHub, Trac). */
    items?: Item[]
    error?: string
}

/** Run one step of the pipeline by itself, in the same environment a run gives it. */
export async function runOneStep(step: Exclude<Step, { kind: 'agent' }>, ctx: StepContext): Promise<SingleStepRun> {
    if (step.kind === 'run') {
        const run = await runScript(step, ctx)
        const failure = scriptFailure(step, run)
        let items: Item[] | undefined
        let error = failure ?? undefined
        if (!failure && step.items) {
            try {
                items = parseItems(run.stdout)
            } catch (e) {
                error = e instanceof Error ? e.message : String(e)
            }
        }
        return {
            kind: 'run',
            ok: !error,
            ms: run.ms,
            stdout: cap(run.stdout, 64_000).text,
            stderr: cap(run.stderr, 16_000).text,
            code: run.code,
            timed_out: run.timedOut,
            ...(items ? { items } : {}),
            ...(error ? { error } : {})
        }
    }
    const at = Date.now()
    try {
        const items = await runSource(step, ctx)
        return {
            kind: step.kind,
            ok: true,
            ms: Date.now() - at,
            stdout: '',
            stderr: '',
            code: 0,
            timed_out: false,
            items
        }
    } catch (error) {
        if (!(error instanceof SourceError)) throw error
        return {
            kind: step.kind,
            ok: false,
            ms: Date.now() - at,
            stdout: '',
            stderr: '',
            code: null,
            timed_out: false,
            error: error.message
        }
    }
}

import fs from 'node:fs'
import path from 'node:path'

import { type Executor, type Launched, LocalExecutor } from '../sandbox/executor.js'
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
    /** It failed and the run went on (`continue_on_error`). */
    continued?: boolean
    /** Switched off (`enabled: false`): the run passed it by. */
    skipped?: boolean
}

/** The pipeline up to the agent: the scripts' text and the sources' items, in the order the steps ran. */
export interface PipelineResult {
    outputs: StepOutput[]
    sources: SourceResult[]
    /** Every step that ran, in order. */
    steps: StepResult[]
    ms: number
}

export type StepContext = SourceContext & {
    /** Where scripts run: the routine's project sandbox (its tools are the agent's), or the supervisor. */
    executor?: Executor
}

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
 * One script: `bash -c` in its own process group (or, in a sandbox, marked as one run), so a
 * timeout ends the whole pipeline the script started (`curl | sort`, a loop of ssh calls), not
 * only bash. It runs in the routine's project sandbox, with the tools its agent installed there.
 * The routine's variables (`SKILL_DIR`, `ROUTINE_FILE`, …) are in the environment: bash expands
 * `${SKILL_DIR}` itself, safely inside quotes.
 */
export async function runScript(step: RunStep, ctx: StepContext): Promise<ScriptRun> {
    const started = Date.now()
    const cwd = step.cwd ? path.resolve(ctx.cwd, step.cwd) : ctx.cwd
    const failed = (stderr: string): ScriptRun => ({ stdout: '', stderr, code: null, timedOut: false, ms: 0 })
    if (!fs.existsSync(cwd)) return failed(`directory ${cwd} does not exist`)
    let launched: Launched
    try {
        launched = await (ctx.executor ?? new LocalExecutor()).launch({
            argv: ['bash', '-c', step.run],
            cwd,
            env: ctx.env,
            project: ctx.project?.slug ?? null,
            stdin: 'ignore'
        })
    } catch (error) {
        return failed(`could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { child } = launched
    return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let killed = false
        let settled = false
        const killGroup = (signal: NodeJS.Signals) => launched.signal(signal)
        const timer = setTimeout(() => {
            killed = true
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref()
        }, step.timeout_s * 1000)
        // Decoded by the streams, so a character split between two chunks stays whole.
        child.stdout!.setEncoding('utf8')
        child.stderr!.setEncoding('utf8')
        child.stdout!.on('data', (chunk: string) => {
            if (stdout.length < BUFFER_MAX) stdout += chunk
        })
        child.stderr!.on('data', (chunk: string) => {
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
                child.stdout!.destroy()
                child.stderr!.destroy()
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
 * before a single token is spent, unless it says `continue_on_error`: then
 * the run goes on and the agent gets the error as that step's output. The
 * agent step is where the pipeline ends. A step with `enabled: false` is
 * passed by.
 */
export async function runPipeline(steps: Step[], ctx: StepContext): Promise<PipelineResult> {
    const started = Date.now()
    const result: PipelineResult = { outputs: [], sources: [], steps: [], ms: 0 }
    const fail = (message: string): never => {
        const error = new StepError(message)
        error.steps = result.steps
        throw error
    }
    // A step that may fail: marked in its result, its error handed to the agent like a script's output.
    const failed = (step: Exclude<Step, { kind: 'agent' }>, message: string, ms: number): void => {
        if (!step.continue_on_error) fail(message)
        result.steps[result.steps.length - 1].continued = true
        const { text, truncated } = cap(`failed, the run went on without it:\n${message}`)
        result.outputs.push({ name: step.name, output: text, ms, truncated })
    }
    for (const [index, step] of steps.entries()) {
        if (step.kind === 'agent') break
        if (!step.enabled) {
            result.steps.push({
                index,
                name: step.name,
                kind: step.kind,
                ok: true,
                ms: 0,
                log: 'switched off',
                skipped: true
            })
            continue
        }
        const at = Date.now()
        if (step.kind === 'run') {
            const run = await runScript(step, ctx)
            const failure = scriptFailure(step, run)
            const done = (ok: boolean, log: string, items?: number) =>
                result.steps.push({ index, name: step.name, kind: step.kind, ok, ms: run.ms, log: head(log), items })
            if (failure) {
                done(false, [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n') || failure)
                failed(step, failure, run.ms)
                continue
            }
            if (step.items) {
                try {
                    const items = parseItems(run.stdout)
                    result.sources.push({ step, items, ms: run.ms })
                    done(true, run.stdout, items.length)
                } catch (error) {
                    const message = `step "${step.name}": ${error instanceof Error ? error.message : String(error)}`
                    done(false, message)
                    failed(step, message, run.ms)
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
            const ms = Date.now() - at
            result.steps.push({ index, name: step.name, kind: step.kind, ok: false, ms, log: message })
            failed(step, message, ms)
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

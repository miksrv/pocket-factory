import { type ChildProcess, spawn } from 'node:child_process'
import readline from 'node:readline'

import { createLogger } from '../logger.js'

const log = createLogger('claude')

/** Events surfaced from the stream while a task runs. */
export type RunnerEvent =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: unknown; id: string }
    | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean }
    | { type: 'rate_limit'; limits: RateLimits }

/** One rolling window of the subscription: share used (0..1) and when it resets. */
export interface RateLimitWindow {
    used: number
    resets_at: string
}

/**
 * Subscription rate-limit status as reported by the CLI after an API call
 * (`rate_limit_event` in stream-json). This is the same data `/usage` shows
 * in the interactive CLI; there is no separate endpoint a setup-token may call.
 */
export interface RateLimits {
    status: 'allowed' | 'allowed_warning' | 'rejected' | string
    five_hour: RateLimitWindow | null
    seven_day: RateLimitWindow | null
}

export interface RunOptions {
    prompt: string
    cwd: string
    /** Continue an existing Claude Code session instead of starting a new one. */
    resumeSessionId?: string
    model?: string
    maxTurns: number
    maxBudgetUsd: number
    permissionMode: string
    /** Extra environment for the CLI (CLAUDE_CONFIG_DIR etc.). */
    env?: NodeJS.ProcessEnv
    /** Called for each assistant text block / tool call as it streams in. */
    onEvent?: (event: RunnerEvent) => void
}

export interface RunResult {
    sessionId: string
    text: string
    isError: boolean
    numTurns: number
    /** The CLI's list-price estimate. Kept for the record; the UI shows tokens and windows. */
    costUsd: number
    durationMs: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    /** Last rate-limit status seen during the run, if the CLI reported one. */
    rateLimits: RateLimits | null
}

/** A running `claude -p` process that can be cancelled. */
export interface RunHandle {
    sessionId: Promise<string>
    result: Promise<RunResult>
    kill: () => void
}

interface ContentBlock {
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
    tool_use_id?: string
    content?: string | Array<{ type: string; text?: string }>
    is_error?: boolean
}

// Shape of the stream-json lines we care about. Everything else is ignored.
interface StreamEvent {
    type: string
    subtype?: string
    session_id?: string
    message?: { content?: ContentBlock[] | string }
    result?: string
    is_error?: boolean
    num_turns?: number
    total_cost_usd?: number
    duration_ms?: number
    usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
    rate_limit_info?: {
        status?: string
        rateLimitType?: string
        resetsAt?: number
        unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>
    }
}

function window(raw: { utilization?: number; resetsAt?: number } | undefined): RateLimitWindow | null {
    if (!raw || typeof raw.utilization !== 'number' || typeof raw.resetsAt !== 'number') return null
    return { used: raw.utilization, resets_at: new Date(raw.resetsAt * 1000).toISOString() }
}

function parseRateLimits(info: NonNullable<StreamEvent['rate_limit_info']>): RateLimits | null {
    const limits: RateLimits = {
        status: info.status ?? 'allowed',
        five_hour: window(info.unifiedWindows?.five_hour),
        seven_day: window(info.unifiedWindows?.seven_day)
    }
    return limits.five_hour || limits.seven_day ? limits : null
}

function blockText(content: ContentBlock['content']): string {
    if (typeof content === 'string') return content
    return (content ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
        .join('')
}

/**
 * Spawn the unmodified Claude Code CLI in print mode and stream its events.
 * The prompt is passed over stdin so long messages never hit argv limits.
 */
export function runClaude(options: RunOptions): RunHandle {
    const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        options.permissionMode,
        '--max-turns',
        String(options.maxTurns),
        '--max-budget-usd',
        String(options.maxBudgetUsd)
    ]
    if (options.model) args.push('--model', options.model)
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)

    log.info(`spawn claude in ${options.cwd}${options.resumeSessionId ? ` (resume ${options.resumeSessionId})` : ''}`)

    const child: ChildProcess = spawn('claude', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe']
    })

    child.stdin!.end(options.prompt)

    let resolveSession: (id: string) => void
    const sessionId = new Promise<string>((resolve) => {
        resolveSession = resolve
    })

    const emit = (event: RunnerEvent) => {
        try {
            options.onEvent?.(event)
        } catch (error) {
            log.warn(`onEvent handler threw: ${error instanceof Error ? error.message : error}`)
        }
    }

    const result = new Promise<RunResult>((resolve, reject) => {
        let finalEvent: StreamEvent | undefined
        let sessionFromInit: string | undefined
        let rateLimits: RateLimits | null = null
        const stderr: string[] = []

        const rl = readline.createInterface({ input: child.stdout! })
        rl.on('line', (line) => {
            if (!line.trim()) return
            let event: StreamEvent
            try {
                event = JSON.parse(line) as StreamEvent
            } catch {
                log.debug(`non-json stdout line: ${line}`)
                return
            }

            if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                sessionFromInit = event.session_id
                resolveSession(event.session_id)
                return
            }
            if (event.type === 'result') {
                finalEvent = event
                return
            }
            if (event.type === 'rate_limit_event' && event.rate_limit_info) {
                const limits = parseRateLimits(event.rate_limit_info)
                if (limits) {
                    rateLimits = limits
                    emit({ type: 'rate_limit', limits })
                }
                return
            }
            const content = event.message?.content
            if (!Array.isArray(content)) return
            if (event.type === 'assistant') {
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        emit({ type: 'text', text: block.text })
                    } else if (block.type === 'tool_use' && block.name) {
                        emit({ type: 'tool_use', name: block.name, input: block.input, id: block.id ?? '' })
                    }
                }
            } else if (event.type === 'user') {
                for (const block of content) {
                    if (block.type === 'tool_result') {
                        emit({
                            type: 'tool_result',
                            toolUseId: block.tool_use_id ?? '',
                            text: blockText(block.content).slice(0, 2000),
                            isError: block.is_error ?? false
                        })
                    }
                }
            }
        })

        child.stderr!.on('data', (chunk: Buffer) => {
            stderr.push(chunk.toString())
        })

        child.on('error', reject)
        child.on('close', (code, signal) => {
            const errText = stderr.join('').trim()
            if (errText) log.debug(`stderr: ${errText}`)

            if (signal) {
                reject(new Error(`claude was terminated by ${signal}`))
                return
            }
            if (!finalEvent) {
                reject(new Error(`claude exited with code ${code} without a result${errText ? `: ${errText}` : ''}`))
                return
            }

            const id = finalEvent.session_id ?? sessionFromInit ?? ''
            resolveSession(id)
            resolve({
                sessionId: id,
                text: finalEvent.result ?? '',
                isError: finalEvent.is_error ?? code !== 0,
                numTurns: finalEvent.num_turns ?? 0,
                costUsd: finalEvent.total_cost_usd ?? 0,
                durationMs: finalEvent.duration_ms ?? 0,
                inputTokens: finalEvent.usage?.input_tokens ?? 0,
                outputTokens: finalEvent.usage?.output_tokens ?? 0,
                cacheReadTokens: finalEvent.usage?.cache_read_input_tokens ?? 0,
                cacheCreationTokens: finalEvent.usage?.cache_creation_input_tokens ?? 0,
                rateLimits
            })
        })
    })

    return {
        sessionId,
        result,
        kill: () => {
            if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
        }
    }
}

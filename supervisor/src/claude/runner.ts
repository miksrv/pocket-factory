import { type ChildProcess, spawn } from 'node:child_process'
import readline from 'node:readline'

import { createLogger } from '../logger.js'

const log = createLogger('claude')

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
    /** Called for each assistant text block as it streams in. */
    onAssistantText?: (text: string) => void
}

export interface RunResult {
    sessionId: string
    text: string
    isError: boolean
    numTurns: number
    costUsd: number
    durationMs: number
    inputTokens: number
    outputTokens: number
}

/** A running `claude -p` process that can be cancelled. */
export interface RunHandle {
    sessionId: Promise<string>
    result: Promise<RunResult>
    kill: () => void
}

// Shape of the stream-json lines we care about. Everything else is ignored.
interface StreamEvent {
    type: string
    subtype?: string
    session_id?: string
    message?: { content?: Array<{ type: string; text?: string }> }
    result?: string
    is_error?: boolean
    num_turns?: number
    total_cost_usd?: number
    duration_ms?: number
    usage?: { input_tokens?: number; output_tokens?: number }
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

    const result = new Promise<RunResult>((resolve, reject) => {
        let finalEvent: StreamEvent | undefined
        let sessionFromInit: string | undefined
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
            } else if (event.type === 'assistant' && options.onAssistantText) {
                for (const block of event.message?.content ?? []) {
                    if (block.type === 'text' && block.text) options.onAssistantText(block.text)
                }
            } else if (event.type === 'result') {
                finalEvent = event
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
                outputTokens: finalEvent.usage?.output_tokens ?? 0
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

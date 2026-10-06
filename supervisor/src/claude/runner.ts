import { type ChildProcess, spawn } from 'node:child_process'
import readline from 'node:readline'

import { createLogger } from '../logger.js'

const log = createLogger('claude')

/**
 * Who produced an event: `agent` is the sub-agent type (`Explore`,
 * `developer`, …) or null for the orchestrator itself; `parentToolUseId` is
 * the Agent tool call that spawned the sub-agent.
 */
export interface EventOrigin {
    agent: string | null
    parentToolUseId: string | null
}

/** Events surfaced from the stream while a task runs. */
export type RunnerEvent = EventOrigin &
    (
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: unknown; id: string }
        | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean }
        /** One model call (one assistant message), with its token usage. */
        | {
              type: 'llm'
              model: string
              messageId: string
              tokens: number
              inputTokens: number
              outputTokens: number
              cacheReadTokens: number
              cacheCreationTokens: number
          }
        /** A sub-agent started or finished. `agent` is the sub-agent itself. */
        | {
              type: 'agent'
              phase: 'started' | 'completed' | 'failed'
              toolUseId: string
              description: string
              tokens?: number
              toolUses?: number
              durationMs?: number
          }
        | { type: 'rate_limit'; limits: RateLimits }
        /** The CLI's session setup: which tools this run has and which MCP servers it connected. */
        | { type: 'init'; tools: string[]; model: string; mcpServers: McpServerStatus[] }
        /**
         * The CLI paused a tool call and asks the supervisor (`can_use_tool`): the agent's
         * `AskUserQuestion`, or a permission request for another tool. The run waits until
         * `RunHandle.answer` is called with this `requestId`.
         */
        | {
              type: 'ask'
              requestId: string
              toolName: string
              toolUseId: string
              input: Record<string, unknown>
              requiresUserInteraction: boolean
          }
        /** The CLI withdrew a pending request (the turn was interrupted). */
        | { type: 'ask_cancelled'; requestId: string }
    )

/** The supervisor's answer to an `ask`: let the tool run (with the owner's answers folded into its input) or refuse it. */
export type AskResponse =
    { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }

/** An MCP server as the CLI reported it at session start. */
export interface McpServerStatus {
    name: string
    status: string
    /** Where the CLI found it: `project` (.mcp.json), `user`, `--mcp-config` … */
    source: string | null
}

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
    status: 'allowed' | 'allowed_warning' | 'rejected' | (string & {})
    five_hour: RateLimitWindow | null
    seven_day: RateLimitWindow | null
    /** The window the status is about (`five_hour`, `seven_day`, …) and when it resets, as far as the CLI said; what a `rejected` task waits for. */
    window?: string | null
    resets_at?: string | null
}

export interface RunOptions {
    prompt: string
    cwd: string
    /** Continue an existing Claude Code session instead of starting a new one. */
    resumeSessionId?: string
    model?: string
    maxTurns: number
    permissionMode: string
    /** The CLI's whole environment; defaults to the supervisor's own. */
    env?: NodeJS.ProcessEnv
    /** Wall-clock limit for the run; 0 = none. A hung tool otherwise holds a session slot forever. Paused while an `ask` waits for the owner, then restarted. */
    timeoutMs?: number
    /** Extra MCP servers for this run (`--mcp-config`), as a path to a JSON file. */
    mcpConfig?: string
    /** Settings for this run (`--settings`), e.g. `disabledMcpjsonServers`. */
    settings?: Record<string, unknown>
    /** Directories outside the cwd the session may read without asking (`--add-dir`), e.g. the owner's uploads. */
    addDirs?: string[]
    /** Called for each assistant text block / tool call as it streams in. */
    onEvent?: (event: RunnerEvent) => void
}

export interface RunResult {
    sessionId: string
    text: string
    isError: boolean
    /** The CLI's result subtype: `success`, `error_max_turns`, `error_during_execution`, … */
    subtype: string
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
    /** Sub-agents still running when the `result` arrived: their work after that point reached nobody. */
    openAgentsAtResult: number
}

/** A running `claude -p` process that can be cancelled. */
export interface RunHandle {
    sessionId: Promise<string>
    result: Promise<RunResult>
    /** Ask the CLI to stop; SIGKILL follows if it has not exited after `KILL_GRACE_MS`. */
    kill: () => void
    /** Answer a pending `ask`; false when no such request is waiting (answered, cancelled, or the run ended). */
    answer: (requestId: string, response: AskResponse) => boolean
}

/** How long a stopped CLI gets to exit on its own before SIGKILL. */
const KILL_GRACE_MS = 10_000

/**
 * The CLI answers the `initialize` control request at once; if a build ever
 * does not, the prompt still goes out after this, so a task never hangs on
 * the handshake.
 */
const HANDSHAKE_MS = 10_000
const INIT_REQUEST_ID = 'supervisor-init'

export class RunTimeout extends Error {
    constructor(ms: number) {
        super(`claude ran past the ${Math.round(ms / 60_000)} minute limit and was stopped`)
    }
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
    message?: {
        id?: string
        model?: string
        content?: ContentBlock[] | string
        usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
        }
    }
    /** Set on messages that belong to a sub-agent (the Agent tool call that spawned it). */
    parent_tool_use_id?: string | null
    // system/init
    tools?: Array<string | { name?: string }>
    mcp_servers?: Array<{ name?: string; status?: string; source?: string }>
    model?: string
    subagent_type?: string
    // system/task_* events
    task_id?: string
    tool_use_id?: string
    description?: string
    status?: string
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
    // control protocol (stream-json input): the CLI asks the host, the host answers
    request_id?: string
    request?: {
        subtype?: string
        tool_name?: string
        input?: unknown
        tool_use_id?: string
        requires_user_interaction?: boolean
    }
    response?: { subtype?: string; request_id?: string }
}

function window(raw: { utilization?: number; resetsAt?: number } | undefined): RateLimitWindow | null {
    if (!raw || typeof raw.utilization !== 'number' || typeof raw.resetsAt !== 'number') return null
    return { used: raw.utilization, resets_at: new Date(raw.resetsAt * 1000).toISOString() }
}

function parseRateLimits(info: NonNullable<StreamEvent['rate_limit_info']>): RateLimits | null {
    const limits: RateLimits = {
        status: info.status ?? 'allowed',
        five_hour: window(info.unifiedWindows?.five_hour),
        seven_day: window(info.unifiedWindows?.seven_day),
        window: info.rateLimitType ?? null,
        resets_at: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null
    }
    return limits.five_hour || limits.seven_day ? limits : null
}

function blockText(content: ContentBlock['content']): string {
    if (typeof content === 'string') return content
    return (content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
}

/**
 * Spawn the unmodified Claude Code CLI in print mode and stream its events.
 *
 * stdin carries stream-json too: after the SDK-style `initialize` handshake
 * the prompt goes out as a user message, and stdin stays open until the
 * result so the CLI can ask back. With `--permission-prompt-tool stdio` the
 * CLI offers `AskUserQuestion` to the model and routes it, like any
 * permission prompt, to us as a `can_use_tool` control request; the answer
 * returns as a `control_response`. Without a host the tool does not exist in
 * print mode and the agent can only ask in prose (verified 2026-09-30).
 */
export function runClaude(options: RunOptions): RunHandle {
    const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--permission-prompt-tool',
        'stdio',
        '--verbose',
        '--permission-mode',
        options.permissionMode,
        '--max-turns',
        String(options.maxTurns)
    ]
    if (options.model) args.push('--model', options.model)
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
    if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
    if (options.settings && Object.keys(options.settings).length)
        args.push('--settings', JSON.stringify(options.settings))
    for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)

    log.info(`spawn claude in ${options.cwd}${options.resumeSessionId ? ` (resume ${options.resumeSessionId})` : ''}`)

    // Its own process group, so that a stop also reaches the tools the CLI
    // spawned (a dev server started through Bash would otherwise outlive it).
    const child: ChildProcess = spawn('claude', args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
    })

    // A prompt larger than the pipe buffer raises EPIPE when the CLI exits
    // before reading it (bad --resume id, auth error). Unhandled, that would
    // crash the supervisor; `close` reports the real failure anyway.
    child.stdin!.on('error', (error) => log.debug(`stdin: ${error.message}`))
    let stdinOpen = true
    const write = (message: unknown) => {
        if (!stdinOpen || child.exitCode !== null) return
        child.stdin!.write(`${JSON.stringify(message)}\n`)
    }
    const closeStdin = () => {
        if (!stdinOpen) return
        stdinOpen = false
        child.stdin!.end()
    }
    let promptSent = false
    const sendPrompt = () => {
        if (promptSent) return
        promptSent = true
        write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: options.prompt }] } })
    }
    write({ type: 'control_request', request_id: INIT_REQUEST_ID, request: { subtype: 'initialize', hooks: {} } })

    const signal = (sig: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig)
            else child.kill(sig)
        } catch {
            // already gone
        }
    }
    let timedOut = false
    let stopping = false
    const timers: NodeJS.Timeout[] = []
    const kill = () => {
        stopping = true
        signal('SIGTERM')
        timers.push(setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS))
    }
    timers.push(setTimeout(sendPrompt, HANDSHAKE_MS))

    // The wall-clock limit measures the agent's work, not the owner's
    // thinking time: it is disarmed while a request waits and re-armed in
    // full once the last one is answered.
    const pending = new Set<string>()
    let timeout: NodeJS.Timeout | undefined
    const armTimeout = () => {
        if (!options.timeoutMs || options.timeoutMs <= 0) return
        clearTimeout(timeout)
        timeout = setTimeout(() => {
            timedOut = true
            log.warn(`claude exceeded ${options.timeoutMs} ms, stopping`)
            kill()
        }, options.timeoutMs)
        timers.push(timeout)
    }
    armTimeout()

    const answer = (requestId: string, response: AskResponse): boolean => {
        if (!pending.delete(requestId)) return false
        write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
        if (pending.size === 0) armTimeout()
        return true
    }

    let resolveSession: (id: string) => void
    const sessionId = new Promise<string>((resolve) => {
        resolveSession = resolve
    })

    const emit = (event: RunnerEvent) => {
        try {
            options.onEvent?.(event)
        } catch (error) {
            log.warn(`onEvent handler threw: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    const result = new Promise<RunResult>((resolve, reject) => {
        let finalEvent: StreamEvent | undefined
        let sessionFromInit: string | undefined
        let rateLimits: RateLimits | null = null
        // Sub-agents by the Agent tool call that spawned them, so that events
        // the CLI does not label itself (task_notification) still get an agent.
        const agentsByToolUse = new Map<string, string>()
        /** Started and not yet reported sub-agents; counted the moment the result arrives, not at exit. */
        const openAgents = new Set<string>()
        let openAgentsAtResult = 0
        const seenMessages = new Set<string>()
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

            if (event.type === 'control_response') {
                if (event.response?.request_id === INIT_REQUEST_ID) sendPrompt()
                return
            }
            if (event.type === 'control_request' && event.request_id) {
                const request = event.request ?? {}
                if (request.subtype === 'can_use_tool' && request.tool_name) {
                    pending.add(event.request_id)
                    clearTimeout(timeout)
                    emit({
                        type: 'ask',
                        agent: null,
                        parentToolUseId: null,
                        requestId: event.request_id,
                        toolName: request.tool_name,
                        toolUseId: request.tool_use_id ?? '',
                        input: (request.input && typeof request.input === 'object' ? request.input : {}) as Record<
                            string,
                            unknown
                        >,
                        requiresUserInteraction: request.requires_user_interaction ?? false
                    })
                } else {
                    // Hooks and other host services were not offered in the handshake; refuse anything else politely.
                    write({
                        type: 'control_response',
                        response: {
                            subtype: 'error',
                            request_id: event.request_id,
                            error: `unsupported request ${request.subtype ?? '?'}`
                        }
                    })
                }
                return
            }
            if (event.type === 'control_cancel_request' && event.request_id) {
                if (pending.delete(event.request_id)) {
                    if (pending.size === 0) armTimeout()
                    emit({ type: 'ask_cancelled', agent: null, parentToolUseId: null, requestId: event.request_id })
                }
                return
            }
            if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                sessionFromInit = event.session_id
                resolveSession(event.session_id)
                const tools = (event.tools ?? [])
                    .map((t) => (typeof t === 'string' ? t : (t.name ?? '')))
                    .filter(Boolean)
                const mcpServers = (event.mcp_servers ?? [])
                    .filter((s) => s.name)
                    .map((s) => ({ name: s.name!, status: s.status ?? 'unknown', source: s.source ?? null }))
                if (tools.length)
                    emit({
                        type: 'init',
                        agent: null,
                        parentToolUseId: null,
                        tools,
                        model: event.model ?? '',
                        mcpServers
                    })
                return
            }
            if (
                event.type === 'system' &&
                event.subtype === 'task_started' &&
                event.tool_use_id &&
                event.subagent_type
            ) {
                agentsByToolUse.set(event.tool_use_id, event.subagent_type)
                openAgents.add(event.tool_use_id)
                emit({
                    type: 'agent',
                    phase: 'started',
                    agent: event.subagent_type,
                    parentToolUseId: event.tool_use_id,
                    toolUseId: event.tool_use_id,
                    description: event.description ?? ''
                })
                return
            }
            if (event.type === 'system' && event.subtype === 'task_notification' && event.tool_use_id) {
                const agent = agentsByToolUse.get(event.tool_use_id)
                if (!agent) return
                openAgents.delete(event.tool_use_id)
                const usage = (event as { usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } })
                    .usage
                emit({
                    type: 'agent',
                    phase: event.status === 'completed' ? 'completed' : 'failed',
                    agent,
                    parentToolUseId: event.tool_use_id,
                    toolUseId: event.tool_use_id,
                    description: (event as { summary?: string }).summary ?? '',
                    tokens: usage?.total_tokens,
                    toolUses: usage?.tool_uses,
                    durationMs: usage?.duration_ms
                })
                return
            }
            if (event.type === 'result') {
                finalEvent = event
                openAgentsAtResult = openAgents.size
                closeStdin() // one prompt per run: the CLI exits once stdin ends
                return
            }
            if (event.type === 'rate_limit_event' && event.rate_limit_info) {
                const limits = parseRateLimits(event.rate_limit_info)
                if (limits) {
                    rateLimits = limits
                    emit({ type: 'rate_limit', agent: null, parentToolUseId: null, limits })
                }
                return
            }
            const content = event.message?.content
            if (!Array.isArray(content)) return
            const parentToolUseId = event.parent_tool_use_id ?? null
            const origin: EventOrigin = {
                parentToolUseId,
                agent: parentToolUseId
                    ? (event.subagent_type ?? agentsByToolUse.get(parentToolUseId) ?? 'sub-agent')
                    : null
            }
            if (event.type === 'assistant') {
                // The CLI emits one line per content block, all carrying the
                // same message id and usage: count the model call once.
                const message = event.message!
                if (message.id && message.model && !seenMessages.has(message.id)) {
                    seenMessages.add(message.id)
                    const u = message.usage ?? {}
                    const inputTokens = u.input_tokens ?? 0
                    const outputTokens = u.output_tokens ?? 0
                    const cacheReadTokens = u.cache_read_input_tokens ?? 0
                    const cacheCreationTokens = u.cache_creation_input_tokens ?? 0
                    emit({
                        type: 'llm',
                        ...origin,
                        model: message.model,
                        messageId: message.id,
                        tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
                        inputTokens,
                        outputTokens,
                        cacheReadTokens,
                        cacheCreationTokens
                    })
                }
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        emit({ type: 'text', ...origin, text: block.text })
                    } else if (block.type === 'tool_use' && block.name) {
                        emit({ type: 'tool_use', ...origin, name: block.name, input: block.input, id: block.id ?? '' })
                    }
                }
            } else if (event.type === 'user') {
                for (const block of content) {
                    if (block.type === 'tool_result') {
                        emit({
                            type: 'tool_result',
                            ...origin,
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

        child.on('error', (error) => {
            // spawn failed (no `claude` on PATH): `close` never comes, so the
            // timeout timer would otherwise fire against nothing.
            for (const timer of timers) clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code, signal) => {
            for (const timer of timers) clearTimeout(timer)
            const errText = stderr.join('').trim()
            if (errText) log.debug(`stderr: ${errText}`)

            if (timedOut) {
                reject(new RunTimeout(options.timeoutMs ?? 0))
                return
            }
            // The CLI handles SIGTERM itself and exits with 143, so `signal` is
            // usually null after a stop: report the stop, not a bare exit code.
            if (signal || (stopping && !finalEvent)) {
                reject(new Error(`claude was stopped${signal ? ` by ${signal}` : ''}`))
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
                subtype: finalEvent.subtype ?? (finalEvent.is_error ? 'error' : 'success'),
                numTurns: finalEvent.num_turns ?? 0,
                costUsd: finalEvent.total_cost_usd ?? 0,
                durationMs: finalEvent.duration_ms ?? 0,
                inputTokens: finalEvent.usage?.input_tokens ?? 0,
                outputTokens: finalEvent.usage?.output_tokens ?? 0,
                cacheReadTokens: finalEvent.usage?.cache_read_input_tokens ?? 0,
                cacheCreationTokens: finalEvent.usage?.cache_creation_input_tokens ?? 0,
                rateLimits,
                openAgentsAtResult
            })
        })
    })

    return { sessionId, result, kill, answer }
}

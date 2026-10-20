/**
 * Anthropic Messages API ⇄ OpenAI chat completions, for providers that speak
 * only the latter (OpenAI, Gemini, Groq, LM Studio …). The `claude` CLI talks
 * Messages; the gateway rewrites the request, forwards it and rewrites the
 * answer — both the JSON reply and the SSE stream. Only what the CLI uses is
 * covered: text, images, tool calls and tool results, system prompt, stop
 * reasons and usage. Thinking blocks and cache markers are dropped on the way.
 */

export interface AnthropicBlock {
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
    tool_use_id?: string
    content?: string | AnthropicBlock[]
    is_error?: boolean
    source?: { type: string; media_type?: string; data?: string; url?: string }
}

export interface AnthropicMessage {
    role: 'user' | 'assistant'
    content: string | AnthropicBlock[]
}

export interface AnthropicRequest {
    model: string
    max_tokens?: number
    messages: AnthropicMessage[]
    system?: string | AnthropicBlock[]
    tools?: Array<{ name: string; description?: string; input_schema?: unknown; type?: string }>
    tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean }
    stream?: boolean
    temperature?: number
    top_p?: number
    stop_sequences?: string[]
    [extra: string]: unknown
}

export interface OpenAiMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    tool_call_id?: string
}

export interface OpenAiRequest {
    model: string
    messages: OpenAiMessage[]
    tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>
    tool_choice?: unknown
    max_tokens?: number
    temperature?: number
    top_p?: number
    stop?: string[]
    stream?: boolean
    stream_options?: { include_usage: boolean }
}

export interface OpenAiUsage {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
}

interface OpenAiToolCall {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
}

export interface OpenAiResponse {
    id?: string
    model?: string
    choices?: Array<{
        message?: { content?: string | null; tool_calls?: OpenAiToolCall[]; reasoning_content?: string }
        finish_reason?: string | null
    }>
    usage?: OpenAiUsage
}

export interface OpenAiChunk {
    id?: string
    model?: string
    choices?: Array<{
        delta?: { content?: string | null; tool_calls?: OpenAiToolCall[]; reasoning_content?: string }
        finish_reason?: string | null
    }>
    usage?: OpenAiUsage | null
}

const textOf = (content: AnthropicBlock['content'] | undefined): string =>
    typeof content === 'string'
        ? content
        : (content ?? [])
              .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
              .join('')

function imagePart(block: AnthropicBlock): { type: 'image_url'; image_url: { url: string } } | null {
    const source = block.source
    if (!source) return null
    if (source.type === 'base64' && source.data) {
        return {
            type: 'image_url',
            image_url: { url: `data:${source.media_type ?? 'image/png'};base64,${source.data}` }
        }
    }
    if (source.type === 'url' && source.url) return { type: 'image_url', image_url: { url: source.url } }
    return null
}

/** The chat-completions request for a Messages request. */
export function toOpenAiRequest(request: AnthropicRequest, model: string = request.model): OpenAiRequest {
    const messages: OpenAiMessage[] = []
    const system = typeof request.system === 'string' ? request.system : textOf(request.system)
    if (system.trim()) messages.push({ role: 'system', content: system })

    for (const message of request.messages) {
        if (typeof message.content === 'string') {
            messages.push({ role: message.role, content: message.content })
            continue
        }
        if (message.role === 'assistant') {
            const text = message.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('')
            const calls = message.content
                .filter((b) => b.type === 'tool_use')
                .map((b) => ({
                    id: b.id ?? '',
                    type: 'function' as const,
                    function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) }
                }))
            const entry: OpenAiMessage = { role: 'assistant', content: text || (calls.length ? null : '') }
            if (calls.length) entry.tool_calls = calls
            messages.push(entry)
            continue
        }
        // A user message: tool results first (OpenAI wants them right after the assistant's calls), then the text and images.
        for (const block of message.content) {
            if (block.type !== 'tool_result') continue
            const text = textOf(block.content)
            messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id ?? '',
                content: block.is_error && !/error/i.test(text) ? `Error: ${text}` : text
            })
        }
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
        for (const block of message.content) {
            if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
            else if (block.type === 'image') {
                const part = imagePart(block)
                if (part) parts.push(part)
            } else if (block.type === 'document') parts.push({ type: 'text', text: '[document omitted]' })
        }
        if (parts.length) {
            const onlyText = parts.every((p) => p.type === 'text')
            messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts })
        }
    }

    const out: OpenAiRequest = { model, messages }
    if (request.tools?.length) {
        out.tools = request.tools
            .filter((t) => t.name && (!t.type || t.type === 'custom'))
            .map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema ?? { type: 'object', properties: {} }
                }
            }))
        const choice = request.tool_choice?.type
        if (choice === 'any') out.tool_choice = 'required'
        else if (choice === 'tool' && request.tool_choice?.name)
            out.tool_choice = { type: 'function', function: { name: request.tool_choice.name } }
        else if (choice === 'none') out.tool_choice = 'none'
        else if (choice === 'auto') out.tool_choice = 'auto'
    }
    if (typeof request.max_tokens === 'number') out.max_tokens = request.max_tokens
    if (typeof request.temperature === 'number') out.temperature = request.temperature
    if (typeof request.top_p === 'number') out.top_p = request.top_p
    if (request.stop_sequences?.length) out.stop = request.stop_sequences
    if (request.stream) {
        out.stream = true
        out.stream_options = { include_usage: true }
    }
    return out
}

export function stopReason(finish: string | null | undefined, sawTool: boolean): string {
    if (finish === 'tool_calls' || finish === 'function_call' || (sawTool && (!finish || finish === 'stop')))
        return 'tool_use'
    if (finish === 'length') return 'max_tokens'
    return 'end_turn'
}

function usageOf(usage: OpenAiUsage | null | undefined) {
    const prompt = usage?.prompt_tokens ?? 0
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
    return {
        input_tokens: Math.max(0, prompt - cached),
        output_tokens: usage?.completion_tokens ?? 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0
    }
}

function parseArguments(raw: string | undefined): unknown {
    if (!raw?.trim()) return {}
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return { _raw: raw }
    }
}

let counter = 0
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`

/** The Messages reply for a chat-completions reply. */
export function fromOpenAiResponse(response: OpenAiResponse, model: string): Record<string, unknown> {
    const choice = response.choices?.[0]
    const content: AnthropicBlock[] = []
    const text = choice?.message?.content
    if (typeof text === 'string' && text) content.push({ type: 'text', text })
    for (const call of choice?.message?.tool_calls ?? []) {
        content.push({
            type: 'tool_use',
            id: call.id || newId('toolu'),
            name: call.function?.name ?? '',
            input: parseArguments(call.function?.arguments)
        })
    }
    const sawTool = content.some((b) => b.type === 'tool_use')
    return {
        id: response.id ?? newId('msg'),
        type: 'message',
        role: 'assistant',
        model: response.model ?? model,
        content,
        stop_reason: stopReason(choice?.finish_reason, sawTool),
        stop_sequence: null,
        usage: usageOf(response.usage)
    }
}

export interface SseEvent {
    event: string
    data: Record<string, unknown>
}

/** A tool call of a streamed completion: emitted live while its block is open, buffered while another is. */
interface StreamCall {
    index: number | undefined
    id: string
    name: string
    args: string
    state: 'pending' | 'open' | 'closed'
}

/**
 * One streamed chat completion, re-told as Messages SSE events. Chunks come
 * in any provider's rhythm (text and tool-call fragments by index, the usage
 * alone at the end); the events come out in the Messages order: one
 * `message_start`, blocks opened and closed as the kind changes, then
 * `message_delta` with the stop reason and usage, `message_stop`. Messages
 * blocks cannot interleave, so the first tool call streams live and the calls
 * that arrive while it is open are buffered and told whole when it closes.
 */
export class StreamTranslator {
    private started = false
    private index = -1
    private open: 'text' | StreamCall | null = null
    private calls: StreamCall[] = []
    private finish: string | null = null
    private usage: OpenAiUsage | null = null
    private done = false

    constructor(private readonly model: string) {}

    push(chunk: OpenAiChunk): SseEvent[] {
        const out: SseEvent[] = []
        if (this.done) return out
        this.start(out, chunk)
        if (chunk.usage) this.usage = chunk.usage
        // An upstream error in the stream (a provider's rate limit mid-answer): told as the Messages API tells it.
        const failure = (chunk as { error?: { message?: string; type?: string } }).error
        if (failure) {
            out.push(...this.fail(failure.message ?? 'upstream error', failure.type))
            return out
        }
        const choice = chunk.choices?.[0]
        if (!choice) return out
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string' && delta.content) {
            if (this.open !== 'text') {
                this.close(out)
                this.index++
                this.open = 'text'
                out.push({
                    event: 'content_block_start',
                    data: { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } }
                })
            }
            out.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index: this.index,
                    delta: { type: 'text_delta', text: delta.content }
                }
            })
        }
        for (const fragment of delta.tool_calls ?? []) {
            let call = this.callOf(fragment)
            if (!call) {
                call = {
                    index: fragment.index,
                    id: fragment.id || newId('toolu'),
                    name: fragment.function?.name ?? '',
                    args: '',
                    state: 'pending'
                }
                this.calls.push(call)
                if (this.open === 'text' || !this.open) {
                    this.close(out)
                    this.openCall(out, call)
                }
            }
            const args = fragment.function?.arguments ?? ''
            if (call.state === 'open') this.argsDelta(out, args)
            else if (call.state === 'pending') {
                call.args += args
                if (!call.name) call.name = fragment.function?.name ?? ''
            }
            // A fragment for a call whose block is already closed has nowhere to go.
        }
        if (choice.finish_reason) this.finish = choice.finish_reason
        return out
    }

    /** The closing events; safe to call once the upstream stream ends, whatever came before. */
    end(): SseEvent[] {
        const out: SseEvent[] = []
        if (this.done) return out
        this.start(out, {})
        this.close(out)
        this.done = true
        out.push({
            event: 'message_delta',
            data: {
                type: 'message_delta',
                delta: { stop_reason: stopReason(this.finish, this.calls.length > 0), stop_sequence: null },
                usage: usageOf(this.usage)
            }
        })
        out.push({ event: 'message_stop', data: { type: 'message_stop' } })
        return out
    }

    /** A Messages `error` event; nothing follows it, `end()` included. */
    fail(message: string, type = 'api_error'): SseEvent[] {
        if (this.done) return []
        this.done = true
        return [{ event: 'error', data: { type: 'error', error: { type, message } } }]
    }

    private start(out: SseEvent[], chunk: OpenAiChunk): void {
        if (this.started) return
        this.started = true
        out.push({
            event: 'message_start',
            data: {
                type: 'message_start',
                message: {
                    id: chunk.id ?? newId('msg'),
                    type: 'message',
                    role: 'assistant',
                    model: chunk.model ?? this.model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            }
        })
    }

    /**
     * The call a fragment belongs to: by id, else by index (the latest with it, unless the fragment
     * names another id); a fragment with neither continues the last call unless it names a function.
     */
    private callOf(fragment: OpenAiToolCall): StreamCall | undefined {
        if (fragment.id) {
            const byId = this.calls.find((c) => c.id === fragment.id)
            if (byId) return byId
        }
        if (fragment.index !== undefined) {
            const byIndex = this.calls.filter((c) => c.index === fragment.index).at(-1)
            return byIndex && !fragment.id ? byIndex : undefined
        }
        if (fragment.id || fragment.function?.name) return undefined
        return this.calls.at(-1)
    }

    private openCall(out: SseEvent[], call: StreamCall): void {
        this.index++
        call.state = 'open'
        this.open = call
        out.push({
            event: 'content_block_start',
            data: {
                type: 'content_block_start',
                index: this.index,
                content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} }
            }
        })
        this.argsDelta(out, call.args)
        call.args = ''
    }

    private argsDelta(out: SseEvent[], args: string): void {
        if (!args) return
        out.push({
            event: 'content_block_delta',
            data: {
                type: 'content_block_delta',
                index: this.index,
                delta: { type: 'input_json_delta', partial_json: args }
            }
        })
    }

    /** Closes the open block; a closed tool call lets the buffered ones out, each told whole. */
    private close(out: SseEvent[]): void {
        if (!this.open) return
        const wasTool = this.open !== 'text'
        if (this.open !== 'text') this.open.state = 'closed'
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.index } })
        this.open = null
        if (!wasTool) return
        for (const call of this.calls) {
            if (call.state !== 'pending') continue
            this.openCall(out, call)
            call.state = 'closed'
            out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.index } })
            this.open = null
        }
    }
}

/** One SSE frame as the Messages API writes it. */
export const sseFrame = (event: SseEvent): string => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`

/**
 * `data:` payloads of an SSE byte stream, one JSON object per `data:` line,
 * across chunk boundaries; `[DONE]` ends it. Lines that are not JSON are skipped.
 */
export class SseParser {
    private buffer = ''

    push(chunk: string): Array<Record<string, unknown> | 'DONE'> {
        this.buffer += chunk
        const out: Array<Record<string, unknown> | 'DONE'> = []
        let nl: number
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).replace(/\r$/, '')
            this.buffer = this.buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
                out.push('DONE')
                continue
            }
            try {
                out.push(JSON.parse(data) as Record<string, unknown>)
            } catch {
                // a keep-alive or a partial frame from a proxy; nothing to do
            }
        }
        return out
    }

    /** What is left in the buffer once the stream ends: a last line without its newline. */
    end(): Array<Record<string, unknown> | 'DONE'> {
        return this.buffer ? this.push('\n') : []
    }
}

/** A rough token count for `count_tokens`: about four characters per token, no model loaded for it. */
export function estimateTokens(request: AnthropicRequest): number {
    const text = JSON.stringify([request.system ?? '', request.messages, request.tools ?? []])
    return Math.max(1, Math.ceil(text.length / 4))
}

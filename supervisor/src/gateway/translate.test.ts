import { describe, expect, it } from 'vitest'

import {
    type AnthropicRequest,
    estimateTokens,
    fromOpenAiResponse,
    sseFrame,
    SseParser,
    StreamTranslator,
    toOpenAiRequest
} from './translate.js'

describe('toOpenAiRequest', () => {
    it('maps the system prompt, text, tool calls and tool results', () => {
        const request: AnthropicRequest = {
            model: 'gpt-x',
            max_tokens: 100,
            system: [{ type: 'text', text: 'Be brief.' }],
            messages: [
                { role: 'user', content: 'List files' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Sure.' },
                        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
                        { type: 'text', text: 'Thanks' }
                    ]
                }
            ],
            tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
            tool_choice: { type: 'any' },
            stream: true,
            stop_sequences: ['END']
        }
        const out = toOpenAiRequest(request, 'gpt-x')
        expect(out.messages).toEqual([
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'List files' },
            {
                role: 'assistant',
                content: 'Sure.',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
            { role: 'user', content: 'Thanks' }
        ])
        expect(out.tools).toEqual([
            { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object' } } }
        ])
        expect(out.tool_choice).toBe('required')
        expect(out.stream).toBe(true)
        expect(out.stream_options).toEqual({ include_usage: true })
        expect(out.stop).toEqual(['END'])
        expect(out.max_tokens).toBe(100)
    })

    it('turns images into data URLs and drops thinking blocks', () => {
        const out = toOpenAiRequest({
            model: 'm',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is this?' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
                    ]
                },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', text: 'hmm' },
                        { type: 'text', text: 'A cat.' }
                    ]
                }
            ]
        })
        expect(out.messages[0]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        })
        expect(out.messages[1]).toEqual({ role: 'assistant', content: 'A cat.' })
    })

    it('names a forced tool and marks an error result', () => {
        const out = toOpenAiRequest({
            model: 'm',
            messages: [
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] }
            ],
            tools: [{ name: 'Read' }],
            tool_choice: { type: 'tool', name: 'Read' }
        })
        expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } })
        expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 't', content: 'Error: boom' })
    })
})

describe('fromOpenAiResponse', () => {
    it('builds text and tool_use blocks with the stop reason and usage', () => {
        const reply = fromOpenAiResponse(
            {
                id: 'chatcmpl-1',
                model: 'gpt-x',
                choices: [
                    {
                        message: {
                            content: 'Running',
                            tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }]
                        },
                        finish_reason: 'tool_calls'
                    }
                ],
                usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } }
            },
            'gpt-x'
        )
        expect(reply).toMatchObject({
            id: 'chatcmpl-1',
            type: 'message',
            role: 'assistant',
            model: 'gpt-x',
            content: [
                { type: 'text', text: 'Running' },
                { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
        })
    })

    it('maps length to max_tokens and keeps unparsable arguments', () => {
        const reply = fromOpenAiResponse(
            {
                choices: [
                    {
                        message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{bad' } }] },
                        finish_reason: 'length'
                    }
                ]
            },
            'm'
        )
        expect(reply.stop_reason).toBe('max_tokens')
        expect((reply.content as Array<{ input: unknown }>)[0].input).toEqual({ _raw: '{bad' })
        expect(reply.usage).toEqual({
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        })
    })
})

describe('StreamTranslator', () => {
    it('re-tells text then a tool call as Messages events', () => {
        const t = new StreamTranslator('m')
        const events = [
            ...t.push({ id: 'x', choices: [{ delta: { content: 'Hel' } }] }),
            ...t.push({ choices: [{ delta: { content: 'lo' } }] }),
            ...t.push({
                choices: [
                    { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"co' } }] } }
                ]
            }),
            ...t.push({
                choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmand":"ls"}' } }] } }]
            }),
            ...t.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            ...t.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
            ...t.end()
        ]
        expect(events.map((e) => e.event)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ])
        expect(events[1].data).toMatchObject({ index: 0, content_block: { type: 'text' } })
        expect(events[5].data).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'Bash' } })
        expect(events[6].data).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"co' } })
        expect(events[9].data).toMatchObject({
            delta: { stop_reason: 'tool_use' },
            usage: { input_tokens: 10, output_tokens: 5 }
        })
        // Ended twice: nothing more.
        expect(t.end()).toEqual([])
    })

    it('opens one block per call id when the provider omits the index', () => {
        const t = new StreamTranslator('m')
        const events = [
            ...t.push({
                choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'Read', arguments: '{"p":1}' } }] } }]
            }),
            ...t.push({
                choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'Read', arguments: '{"p":2}' } }] } }]
            }),
            ...t.end()
        ]
        const starts = events.filter((e) => e.event === 'content_block_start')
        expect(starts.map((e) => (e.data.content_block as { id: string }).id)).toEqual(['a', 'b'])
        expect(events.filter((e) => e.event === 'content_block_stop')).toHaveLength(2)
    })

    it('keeps interleaved parallel calls apart, the second told whole when the first closes', () => {
        const t = new StreamTranslator('m')
        const call = (index: number, fn: { name?: string; arguments?: string }, id?: string) =>
            t.push({ choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] } }] })
        const events = [
            ...call(0, { name: 'Read', arguments: '{"p"' }, 'a'),
            ...call(1, { name: 'Grep', arguments: '{"q"' }, 'b'),
            ...call(0, { arguments: ':1}' }),
            ...call(1, { arguments: ':2}' }),
            ...t.end()
        ]
        expect(events.map((e) => e.event)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ])
        expect(events[1].data).toMatchObject({ index: 0, content_block: { id: 'a', name: 'Read' } })
        expect(events[5].data).toMatchObject({ index: 1, content_block: { id: 'b', name: 'Grep' } })
        expect(events[6].data).toMatchObject({ index: 1, delta: { partial_json: '{"q":2}' } })
        const json = (i: number) =>
            events
                .filter((e) => e.event === 'content_block_delta' && e.data.index === i)
                .map((e) => (e.data.delta as { partial_json: string }).partial_json)
                .join('')
        expect(JSON.parse(json(0))).toEqual({ p: 1 })
        expect(JSON.parse(json(1))).toEqual({ q: 2 })
    })

    it('starts a new call for a named fragment without index or id, and continues an anonymous one', () => {
        const t = new StreamTranslator('m')
        const whole = (fn: { name?: string; arguments?: string }) =>
            t.push({ choices: [{ delta: { tool_calls: [{ function: fn }] } }] })
        const events = [...whole({ name: 'A', arguments: '{"a"' }), ...whole({ arguments: ':1}' })]
        events.push(...whole({ name: 'B', arguments: '{"b":2}' }), ...t.end())
        const starts = events.filter((e) => e.event === 'content_block_start')
        expect(starts.map((e) => (e.data.content_block as { name: string }).name)).toEqual(['A', 'B'])
        const deltas = events.filter((e) => e.event === 'content_block_delta')
        expect(deltas.map((e) => [e.data.index, (e.data.delta as { partial_json: string }).partial_json])).toEqual([
            [0, '{"a"'],
            [0, ':1}'],
            [1, '{"b":2}']
        ])
        expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: 'tool_use' } })
    })

    it('says nothing after an error, end() included', () => {
        const t = new StreamTranslator('m')
        t.push({ choices: [{ delta: { content: 'Hi' } }] })
        expect(t.push({ error: { message: 'boom' } } as never).map((e) => e.event)).toEqual(['error'])
        expect(t.push({ choices: [{ delta: { content: 'more' } }] })).toEqual([])
        expect(t.end()).toEqual([])
        expect(t.fail('again')).toEqual([])
    })

    it('tells an upstream error as a Messages error event', () => {
        const t = new StreamTranslator('m')
        const events = t.push({ error: { message: 'quota', type: 'rate_limit_error' } } as never)
        expect(events.map((e) => e.event)).toEqual(['message_start', 'error'])
        expect(events[1].data).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } })
    })

    it('ends an empty stream with a complete message', () => {
        const t = new StreamTranslator('m')
        const events = t.end()
        expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop'])
        expect(events[1].data).toMatchObject({ delta: { stop_reason: 'end_turn' } })
    })

    it('writes SSE frames the way the Messages API does', () => {
        expect(sseFrame({ event: 'ping', data: { type: 'ping' } })).toBe('event: ping\ndata: {"type":"ping"}\n\n')
    })
})

describe('SseParser', () => {
    it('yields data payloads across chunk boundaries and sees [DONE]', () => {
        const p = new SseParser()
        expect(p.push('data: {"a":1}\n\ndata: {"b"')).toEqual([{ a: 1 }])
        expect(p.push(':2}\r\n: keep-alive\ndata: [DONE]\n')).toEqual([{ b: 2 }, 'DONE'])
    })

    it('hands over a last line without its newline at the end', () => {
        const p = new SseParser()
        expect(p.push('data: {"a":1}\ndata: {"b":2}')).toEqual([{ a: 1 }])
        expect(p.end()).toEqual([{ b: 2 }])
        expect(p.end()).toEqual([])
    })
})

describe('estimateTokens', () => {
    it('counts about four characters per token', () => {
        const n = estimateTokens({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(400) }] })
        expect(n).toBeGreaterThan(90)
        expect(n).toBeLessThan(130)
    })
})

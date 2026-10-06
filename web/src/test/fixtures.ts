import type { Ask, Task } from '../lib/api'

/** A task row with every field filled in; override what the test is about. */
export function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't1',
        conversation_id: 'c1',
        source: 'web',
        prompt: 'Fix the login page',
        status: 'running',
        session_id: null,
        result: null,
        error: null,
        num_turns: 0,
        cost_usd: 0,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        window_5h_delta: null,
        project: null,
        restarts: 0,
        ask: null,
        schedule: null,
        attachments: null,
        not_before: null,
        limit_waits: 0,
        git: null,
        created_at: '2026-10-06 10:00:00',
        started_at: '2026-10-06 10:00:01',
        finished_at: null,
        ...overrides
    }
}

/** What a task waits for; a question by default. */
export function makeAsk(overrides: Partial<Ask> = {}): Ask {
    return {
        kind: 'question',
        request_id: 'r1',
        tool_use_id: 'tu1',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        answers: {},
        agent: null,
        asked_at: '2026-10-06 10:01:00',
        ...overrides
    }
}

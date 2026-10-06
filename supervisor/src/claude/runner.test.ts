import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runClaude } from './runner.js'

// The fake CLI of the Playwright suite speaks the same stream-json protocol (see its header).
const FAKE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../e2e/fixtures/bin')

const run = (prompt: string) =>
    runClaude({
        prompt,
        cwd: process.cwd(),
        maxTurns: 5,
        permissionMode: 'default',
        env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ''}` }
    }).result

describe('runClaude', () => {
    it('returns the answer to the prompt', async () => {
        const result = await run('hello')
        expect(result.text).toBe('Echo: hello')
        expect(result.isError).toBe(false)
        expect(result.openAgentsAtResult).toBe(0)
        expect(result.stoppedAgentsAtResult).toBe(0)
    })

    it('skips a result the CLI produced before it took the prompt', async () => {
        // A resumed session first answers the notifications about background tasks the
        // previous run left behind: an empty result of 0 turns, then the prompt's own.
        const result = await run('orphan check')
        expect(result.text).toBe('Echo: orphan check')
        expect(result.numTurns).toBe(1)
    })

    it('counts a sub-agent stopped after the orchestrator last spoke', async () => {
        const result = await run('stopped agent')
        expect(result.text).toBe('Waiting for the client report.')
        expect(result.openAgentsAtResult).toBe(0)
        expect(result.stoppedAgentsAtResult).toBe(1)
    })

    it('reports an error result as an error', async () => {
        const result = await run('please fail')
        expect(result.isError).toBe(true)
    })
})

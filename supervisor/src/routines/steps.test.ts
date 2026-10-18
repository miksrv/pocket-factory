import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunStep } from './spec.js'
import { cap, runPipeline } from './steps.js'

const ctx = {
    cwd: process.cwd(),
    env: { ...process.env, SKILL_DIR: '/data/claude/skills/stats', PROJECT_DIR: '/w/shop' },
    project: null
}
const script = (run: string, over: Partial<RunStep> = {}): RunStep => ({
    kind: 'run',
    name: 'step',
    run,
    timeout_s: 10,
    items: false,
    new_only: false,
    ...over
})

describe('cap', () => {
    it('keeps a short output whole and cuts a long one in the middle', () => {
        expect(cap('abc')).toEqual({ text: 'abc', truncated: false })
        const long = `${'a'.repeat(20_000)}${'z'.repeat(20_000)}`
        const cut = cap(long, 1000)
        expect(cut.truncated).toBe(true)
        expect(cut.text.startsWith('a'.repeat(700))).toBe(true)
        expect(cut.text.endsWith('z'.repeat(300))).toBe(true)
        expect(cut.text).toContain('[39000 characters cut]')
    })
})

describe('runPipeline', () => {
    it('runs the scripts in order with the routine variables (bash expands them), text and items apart, and stops at the agent', async () => {
        const result = await runPipeline(
            [
                script('echo "skill=${SKILL_DIR}"; echo two >&2', { name: 'one' }),
                script('printf "%s" "$PROJECT_DIR"', { name: 'two' }),
                script("printf 'a\\tAlpha\\nb\\n'", { name: 'list', items: true, new_only: true }),
                { kind: 'agent', name: 'agent', agent: null, skill: null },
                script('echo never', { name: 'after' })
            ],
            ctx
        )
        expect(result.outputs.map((o) => [o.name, o.output])).toEqual([
            ['one', 'skill=/data/claude/skills/stats\n'],
            ['two', '/w/shop']
        ])
        expect(result.sources).toMatchObject([
            {
                step: { name: 'list' },
                items: [
                    { key: 'a', title: 'Alpha' },
                    { key: 'b', title: 'b' }
                ]
            }
        ])
        expect(result.outputs.every((o) => o.ms >= 0 && !o.truncated)).toBe(true)
    })

    it('stops at a failing step and names it with its last lines', async () => {
        await expect(
            runPipeline(
                [
                    script('true', { name: 'fine' }),
                    script('echo nope >&2; exit 3', { name: 'stats' }),
                    script('echo x')
                ],
                ctx
            )
        ).rejects.toThrow('step "stats" exited with 3: nope')
    })

    it('names the step whose items do not parse', async () => {
        await expect(
            runPipeline([script("echo '[not json'", { name: 'bad', items: true, new_only: true })], ctx)
        ).rejects.toThrow(/step "bad": output starts with "\[" but is not a JSON array/)
    })

    it('stops a step that runs past its timeout, children included, and resolves a relative cwd against the checkout', async () => {
        const started = Date.now()
        await expect(runPipeline([script('sleep 30 | cat', { name: 'slow', timeout_s: 5 })], ctx)).rejects.toThrow(
            /timed out after 5 s/
        )
        expect(Date.now() - started).toBeLessThan(9000)
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-'))
        fs.mkdirSync(path.join(root, 'sub'))
        const result = await runPipeline([script('pwd', { name: 'here', cwd: 'sub' })], { ...ctx, cwd: root })
        expect(fs.realpathSync(result.outputs[0].output.trim())).toBe(fs.realpathSync(path.join(root, 'sub')))
        await expect(
            runPipeline([script('pwd', { name: 'gone', cwd: 'nope' })], { ...ctx, cwd: root })
        ).rejects.toThrow(/directory .* does not exist/)
    }, 15_000)

    it('ends a step when bash exits, though a child left in the background holds its output open', async () => {
        const started = Date.now()
        const result = await runPipeline([script('echo started; sleep 30 &', { name: 'bg', timeout_s: 5 })], ctx)
        expect(result.outputs[0].output.trim()).toBe('started')
        expect(Date.now() - started).toBeLessThan(3000)
    }, 10_000)

    it('keeps a multi-byte character whole across output chunks', async () => {
        // 65535 ASCII bytes, then two-byte letters: the first falls on the 64 KB chunk boundary.
        const result = await runPipeline(
            [script(`head -c 65535 /dev/zero | tr '\\0' a; printf 'жжжж'`, { name: 'utf', items: false })],
            ctx
        )
        expect(result.outputs[0].output).not.toContain('\uFFFD')
        expect(result.outputs[0].output).toContain('жжжж')
    })
})

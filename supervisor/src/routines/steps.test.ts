import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunStep, Step } from './spec.js'
import { cap, runPipeline, StepError } from './steps.js'

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
    continue_on_error: false,
    enabled: true,
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

    it('passes a switched-off step by without running it', async () => {
        const result = await runPipeline(
            [script('exit 9', { name: 'webmaster', enabled: false }), script('echo after', { name: 'next' })],
            ctx
        )
        expect(result.steps.map((s) => [s.name, s.ok, s.skipped])).toEqual([
            ['webmaster', true, true],
            ['next', true, undefined]
        ])
        expect(result.outputs.map((o) => o.name)).toEqual(['next'])
    })

    it('goes on past a failing step that says continue_on_error and hands its error to the agent', async () => {
        const result = await runPipeline(
            [
                script('echo nope >&2; exit 3', { name: 'metrika', continue_on_error: true }),
                script("echo '[not json'", { name: 'list', items: true, new_only: true, continue_on_error: true }),
                script('echo after', { name: 'next' })
            ],
            ctx
        )
        expect(result.steps.map((s) => [s.name, s.ok, s.continued])).toEqual([
            ['metrika', false, true],
            ['list', false, true],
            ['next', true, undefined]
        ])
        expect(result.outputs.map((o) => o.name)).toEqual(['metrika', 'list', 'next'])
        expect(result.outputs[0].output).toBe('failed, the run went on without it:\nstep "metrika" exited with 3: nope')
        expect(result.sources).toEqual([])
    })

    it('ends a timed-out step even when a child left its process group and holds the pipes', async () => {
        const started = Date.now()
        const escapee = `python3 -c "import os,time; os.setsid(); time.sleep(20)" & sleep 30`
        await expect(runPipeline([script(escapee, { name: 'stuck', timeout_s: 5 })], ctx)).rejects.toThrow(
            /timed out after 5 s/
        )
        expect(Date.now() - started).toBeLessThan(9000)
    }, 15_000)

    it('kills a child that ignores SIGTERM once bash has gone with it', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-'))
        const pidFile = path.join(root, 'pid')
        const stubborn = `(trap '' TERM; exec sleep 60) & echo $! > ${pidFile}; wait`
        await expect(runPipeline([script(stubborn, { name: 'stubborn', timeout_s: 1 })], ctx)).rejects.toThrow(
            /timed out after 1 s/
        )
        const pid = Number(fs.readFileSync(pidFile, 'utf8'))
        const alive = () => {
            try {
                process.kill(pid, 0)
                return true
            } catch {
                return false
            }
        }
        const until = Date.now() + 2000
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
        if (alive()) process.kill(pid, 'SIGKILL')
        expect(alive()).toBe(false)
    }, 10_000)

    it('records a source that throws something unexpected as a failed step, with the steps so far', async () => {
        // A `gh` that answers JSON of another shape: the source's code throws a TypeError, not a SourceError.
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-gh-'))
        fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 })
        const prs: Step = {
            kind: 'github-prs',
            name: 'prs',
            repos: ['a/b'],
            filter: 'open',
            mine: false,
            drafts: false,
            new_only: true,
            continue_on_error: false,
            enabled: true
        }
        const env = { ...ctx.env, PATH: `${bin}:${process.env.PATH}` }
        const error = await runPipeline([script('echo first', { name: 'first' }), prs], { ...ctx, env }).catch(
            (e: unknown) => e
        )
        expect(error).toBeInstanceOf(StepError)
        expect((error as StepError).message).toMatch(/^step "prs": /)
        expect((error as StepError).steps.map((s) => [s.name, s.ok])).toEqual([
            ['first', true],
            ['prs', false]
        ])
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

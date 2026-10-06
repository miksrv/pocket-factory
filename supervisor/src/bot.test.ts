import { describe, expect, it } from 'vitest'

import { chunk } from './bot.js'

const LIMIT = 4000

const fences = (part: string) => part.split('\n').filter((l) => /^\s*```/.test(l)).length

describe('chunk', () => {
    it('keeps a short text whole', () => {
        expect(chunk('hello')).toEqual(['hello'])
        expect(chunk('')).toEqual([''])
        expect(chunk('x'.repeat(LIMIT))).toEqual(['x'.repeat(LIMIT)])
    })

    it('cuts on a line break and drops the leading whitespace of the next part', () => {
        const line = 'y'.repeat(99)
        const text = Array.from({ length: 60 }, () => line).join('\n')
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(part.startsWith('\n')).toBe(false)
        }
        expect(parts.join('\n')).toBe(text)
    })

    it('cuts a text without line breaks at the limit', () => {
        const text = 'z'.repeat(LIMIT * 2 + 10)
        expect(chunk(text).map((p) => p.length)).toEqual([LIMIT, LIMIT, 10])
    })

    it('cuts at the limit when the last line break is too early', () => {
        const text = `short\n${'w'.repeat(LIMIT * 2)}`
        expect(chunk(text)[0]).toHaveLength(LIMIT)
    })

    it('closes and reopens a code fence that straddles a cut, keeping its language', () => {
        const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${'0'.repeat(50)}`).join('\n')
        const text = `Intro\n\`\`\`ts\n${code}\n\`\`\`\nOutro`
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThanOrEqual(2)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(fences(part) % 2).toBe(0)
        }
        expect(parts[0].endsWith('\n```')).toBe(true)
        expect(parts[1].startsWith('```ts\n')).toBe(true)
        expect(parts.at(-1)!.endsWith('```\nOutro')).toBe(true)
    })

    it('keeps the fences balanced across three or more parts', () => {
        const code = Array.from({ length: 400 }, (_, i) => `line ${i} ${'.'.repeat(40)}`).join('\n')
        const parts = chunk(`\`\`\`python\n${code}\n\`\`\``)
        expect(parts.length).toBeGreaterThanOrEqual(3)
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(LIMIT)
            expect(fences(part) % 2).toBe(0)
        }
        expect(parts.slice(1).every((part) => part.startsWith('```python\n'))).toBe(true)
    })

    it('does not reopen a fence that closed before the cut', () => {
        const text = `\`\`\`\nshort\n\`\`\`\n${Array.from({ length: 80 }, () => 'p'.repeat(80)).join('\n')}`
        const parts = chunk(text)
        expect(parts.length).toBeGreaterThan(1)
        expect(parts[1].startsWith('```')).toBe(false)
    })
})

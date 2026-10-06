import { describe, expect, it } from 'vitest'

import { DEFAULT_MODEL, isModelAlias, MODEL_ALIASES } from './models.js'

describe('isModelAlias', () => {
    it.each([...MODEL_ALIASES])('accepts %s', (alias) => {
        expect(isModelAlias(alias)).toBe(true)
    })

    it.each(['inherit', 'Sonnet', ' opus', 'claude-sonnet-4-5', '', null, undefined, 1, ['haiku']])(
        'refuses %j',
        (value) => {
            expect(isModelAlias(value)).toBe(false)
        }
    )

    it('has a default among the aliases', () => {
        expect(isModelAlias(DEFAULT_MODEL)).toBe(true)
    })
})

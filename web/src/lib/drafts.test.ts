import { describe, expect, it } from 'vitest'

import { readDraft, writeDraft } from './drafts'

describe('drafts', () => {
    it('keeps a draft per conversation and removes an empty one', () => {
        writeDraft('a', 'hello')
        writeDraft('b', 'other')
        expect(readDraft('a')).toBe('hello')
        expect(readDraft('b')).toBe('other')
        writeDraft('a', '')
        expect(readDraft('a')).toBe('')
    })
})

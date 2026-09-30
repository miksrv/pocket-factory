/**
 * Unsent chat drafts, one per conversation, in `localStorage`: a message
 * typed in a thread survives a trip to another page (or a reload) and is
 * back in the composer when the thread reopens. Storage may be missing or
 * full (private mode, quota): every call degrades to "no draft".
 */
const KEY = 'pf.chat.draft.'

export function readDraft(conversationId: string): string {
    try {
        return localStorage.getItem(KEY + conversationId) ?? ''
    } catch {
        return ''
    }
}

/** An empty draft removes the entry, so storage holds only what is worth restoring. */
export function writeDraft(conversationId: string, text: string): void {
    try {
        if (text) localStorage.setItem(KEY + conversationId, text)
        else localStorage.removeItem(KEY + conversationId)
    } catch {
        // private mode, quota exceeded: the draft lives in the textarea only
    }
}

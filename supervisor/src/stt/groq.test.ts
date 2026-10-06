import { describe, expect, it } from 'vitest'

import { uploadName } from './groq.js'

describe('uploadName', () => {
    it.each([
        ['voice/file_12.oga', undefined, 'file_12.ogg'],
        ['voice.OGG', undefined, 'voice.OGG'],
        ['note.m4a', 'audio/ogg', 'note.m4a'],
        ['clip.aac', undefined, 'clip.m4a'],
        ['rec.mpga', undefined, 'rec.mpga'],
        ['audio.bin', 'audio/mpeg; codecs=mp3', 'audio.mp3'],
        ['audio.bin', 'AUDIO/X-WAV', 'audio.wav'],
        ['noext', 'video/webm', 'noext.webm'],
        ['noext', undefined, 'noext.ogg'],
        ['weird.xyz', 'application/octet-stream', 'weird.ogg'],
        ['dir/', undefined, 'audio.ogg'],
        ['a.b/c.d/e.flac', undefined, 'e.flac']
    ])('%s (%s) → %s', (file, mime, name) => {
        expect(uploadName(file, mime)).toBe(name)
    })
})

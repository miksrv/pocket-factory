import { createLogger } from '../logger.js'

const log = createLogger('stt')

export interface SttOptions {
    apiKey: string
    model: string
    /** Optional language hint (ISO-639-1); Whisper autodetects when omitted. */
    language?: string
    /** MIME type as reported by the sender (Telegram), used when the file name's extension says nothing useful. */
    mimeType?: string
}

/** Extensions Groq's Whisper endpoint accepts; it judges the format by the upload's file name. */
const ACCEPTED = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm'])

const BY_MIME: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
}

/**
 * The name to upload under. Telegram voice notes arrive as `voice/file_N.oga`:
 * plain OGG/Opus, but `.oga` is not on Groq's list, so the extension is
 * rewritten from the MIME type (or from a few known aliases) and the rest
 * of the path is dropped.
 */
export function uploadName(filename: string, mimeType?: string): string {
    const base = filename.split('/').pop() || 'audio'
    const dot = base.lastIndexOf('.')
    const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
    if (ACCEPTED.has(ext)) return base
    const alias: Record<string, string> = { oga: 'ogg', ogv: 'ogg', aac: 'm4a', mpga: 'mp3' }
    const guess = alias[ext] ?? (mimeType ? BY_MIME[mimeType.split(';')[0].trim().toLowerCase()] : undefined) ?? 'ogg'
    return `${dot >= 0 ? base.slice(0, dot) : base}.${guess}`
}

/**
 * Transcribe an audio buffer with Groq's OpenAI-compatible Whisper endpoint.
 * Telegram voice notes are OGG/Opus, which Whisper accepts as-is.
 */
export async function transcribe(audio: Buffer, filename: string, options: SttOptions): Promise<string> {
    const name = uploadName(filename, options.mimeType)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], options.mimeType ? { type: options.mimeType } : undefined), name)
    form.append('model', options.model)
    form.append('response_format', 'json')
    if (options.language) form.append('language', options.language)

    const started = Date.now()
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Groq STT failed: HTTP ${response.status} ${body.slice(0, 200)}`)
    }
    const json = (await response.json()) as { text?: string }
    const text = (json.text ?? '').trim()
    log.info(`transcribed ${audio.length} bytes in ${Date.now() - started}ms: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`)
    return text
}

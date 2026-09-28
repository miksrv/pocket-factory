import { createLogger } from '../logger.js'

const log = createLogger('stt')

export interface SttOptions {
    apiKey: string
    model: string
    /** Optional language hint (ISO-639-1); Whisper autodetects when omitted. */
    language?: string
}

/**
 * Transcribe an audio buffer with Groq's OpenAI-compatible Whisper endpoint.
 * Telegram voice notes are OGG/Opus, which Whisper accepts as-is.
 */
export async function transcribe(audio: Buffer, filename: string, options: SttOptions): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)]), filename)
    form.append('model', options.model)
    form.append('response_format', 'json')
    if (options.language) form.append('language', options.language)

    const started = Date.now()
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form
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

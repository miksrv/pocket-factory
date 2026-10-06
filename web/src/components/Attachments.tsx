import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'

import { api, type Attachment, attachmentUrl, fmt, isImage } from '../lib/api'
import { CloseButton } from './ui'

/** The inbox prefixes a timestamp and a random part ("20261006-094112-a1b2c3-"); the owner sees the name they sent. */
export const displayName = (a: Attachment) => a.name.replace(/^\d{8}-\d{6}-[0-9a-f]{6}-/, '')

/** Files sent with a message, under its bubble: images as thumbnails that open full size, other files as chips. */
/** `removed`: the conversation was deleted, and its files with it (the task page still lists them). */
export function SentAttachments({
    conversationId,
    attachments,
    removed
}: {
    conversationId: string
    attachments: Attachment[] | null
    removed?: boolean
}) {
    // An image that no longer loads is treated the same way.
    const [failed, setMissing] = useState<Set<string>>(() => new Set())
    const missing = removed ? new Set((attachments ?? []).map((a) => a.name)) : failed
    if (!attachments?.length) return null
    return (
        <div className='attachments'>
            {attachments.map((a) =>
                missing.has(a.name) ? (
                    <span
                        key={a.name}
                        className='attachment-chip gone'
                        title='Removed from the disk together with its conversation'
                    >
                        <FileText size={13} />
                        <span className='name'>{displayName(a)}</span>
                        <span className='dim'>removed</span>
                    </span>
                ) : isImage(a) ? (
                    <a
                        key={a.name}
                        href={attachmentUrl(conversationId, a)}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='attachment-thumb'
                        title={displayName(a)}
                    >
                        <img
                            src={attachmentUrl(conversationId, a)}
                            alt={displayName(a)}
                            loading='lazy'
                            onError={() => setMissing((m) => new Set(m).add(a.name))}
                        />
                    </a>
                ) : (
                    <a
                        key={a.name}
                        href={attachmentUrl(conversationId, a)}
                        className='attachment-chip'
                        title={a.path}
                        download={displayName(a)}
                    >
                        <FileText size={13} />
                        <span className='name'>{displayName(a)}</span>
                        <span className='dim'>{fmt.bytes(a.size)}</span>
                    </a>
                )
            )}
        </div>
    )
}

/** The server's limits (MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES in supervisor/src/files/inbox.ts), checked here first so a chip says why at once. */
export const MAX_FILES = 10
const MAX_BYTES = 20 * 1024 * 1024

export interface Upload {
    key: string
    file: File
    preview: string | null
    status: 'uploading' | 'done' | 'error'
    attachment?: Attachment
    error?: string
}

/**
 * Files picked, pasted or dropped into the composer: each is uploaded at
 * once, so Send only names files the server already has. A failed one stays
 * as a red chip until removed; previews are object URLs, revoked on removal.
 */
export function useUploads(conversationId: string) {
    const [uploads, setUploads] = useState<Upload[]>([])
    // How many files the composer holds right now: two pastes before a re-render must not both see the old count.
    const count = useRef(0)
    count.current = uploads.length
    const urls = useRef(new Set<string>())
    useEffect(
        () => () => {
            for (const url of urls.current) URL.revokeObjectURL(url)
        },
        []
    )

    const patch = (key: string, change: Partial<Upload>) =>
        setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)))

    const add = (files: File[]) => {
        const room = Math.max(0, MAX_FILES - count.current)
        count.current += Math.min(room, files.length)
        for (const file of files.slice(0, room)) {
            const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
            const preview = isImage({ name: file.name, path: '', type: file.type, size: file.size })
                ? URL.createObjectURL(file)
                : null
            if (preview) urls.current.add(preview)
            const tooBig = file.size > MAX_BYTES
            setUploads((list) => [
                ...list,
                {
                    key,
                    file,
                    preview,
                    status: tooBig ? 'error' : 'uploading',
                    error: tooBig ? 'larger than 20 MB' : undefined
                }
            ])
            if (tooBig) continue
            api.uploadAttachment(conversationId, file)
                .then((attachment) => patch(key, { status: 'done', attachment }))
                .catch((e: Error) => patch(key, { status: 'error', error: e.message }))
        }
    }

    const remove = (key: string) =>
        setUploads((list) => {
            const gone = list.find((u) => u.key === key)
            if (gone?.preview) {
                URL.revokeObjectURL(gone.preview)
                urls.current.delete(gone.preview)
            }
            return list.filter((u) => u.key !== key)
        })

    const clear = () => {
        for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview)
        urls.current.clear()
        setUploads([])
    }

    return {
        uploads,
        add,
        remove,
        clear,
        busy: uploads.some((u) => u.status === 'uploading'),
        names: uploads.filter((u) => u.status === 'done').map((u) => u.attachment!.name)
    }
}

/** The composer's row of files about to be sent. */
export function PendingUploads({ uploads, onRemove }: { uploads: Upload[]; onRemove: (key: string) => void }) {
    if (!uploads.length) return null
    return (
        <div className='composer-files'>
            {uploads.map((u) => (
                <div
                    key={u.key}
                    className={`attachment-chip ${u.status}`}
                    title={u.error ?? u.file.name}
                >
                    {u.preview ? (
                        <img
                            src={u.preview}
                            alt=''
                        />
                    ) : (
                        <FileText size={13} />
                    )}
                    <span className='name'>{u.file.name || 'pasted image'}</span>
                    <span className='dim'>
                        {u.status === 'uploading'
                            ? 'uploading…'
                            : u.status === 'error'
                              ? u.error
                              : fmt.bytes(u.file.size)}
                    </span>
                    <CloseButton
                        className='remove'
                        label={`Remove ${u.file.name || 'the pasted image'}`}
                        onClick={() => onRemove(u.key)}
                    />
                </div>
            ))}
        </div>
    )
}

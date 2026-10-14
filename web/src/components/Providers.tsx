import { useEffect, useState } from 'react'

import { api, type Provider, type ProviderTest, type ProviderView } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Modal, useConfirm } from './Modal'
import { Button } from './ui'

/**
 * Model providers besides the subscription: self-hosted models (Ollama on a
 * GPU box, llama.cpp, vLLM) and cloud APIs (OpenRouter, Gemini, OpenAI, Groq).
 * The list lives in Settings → Providers (`data/config/providers.yaml`); an
 * agent, a schedule or a chat picks one with `ModelPicker`. Keys never pass
 * through here: a provider names the .env variable that holds its key.
 */

export const CLAUDE_ALIASES: Array<{ value: string; label: string }> = [
    { value: 'sonnet', label: 'sonnet — current Sonnet' },
    { value: 'opus', label: 'opus — current Opus' },
    { value: 'haiku', label: 'haiku — current Haiku' },
    { value: 'fable', label: 'fable — current Fable (Max plans)' }
]

const EMPTY: Provider = {
    name: '',
    kind: 'anthropic',
    url: '',
    token: '',
    models: [],
    default: '',
    small: '',
    concurrency: 1,
    light: true
}

/**
 * Provider + model, as a pair of selects: the subscription with the CLI's
 * aliases, or a provider with its model list (any id can be typed). `value`
 * is what a file or a conversation holds; the empty provider is the subscription.
 */
export function ModelPicker({
    provider,
    model,
    onChange,
    providers,
    disabled,
    inherit = "inherit — factory's current model",
    aliases,
    compact
}: {
    provider: string
    model: string
    onChange: (provider: string, model: string) => void
    providers: ProviderView[] | undefined
    disabled?: boolean
    /** Label of the empty model choice on the subscription. */
    inherit?: string
    /** The subscription's choices instead of the CLI aliases with `inherit` first (the agent form has its own list). */
    aliases?: Array<{ value: string; label: string }>
    compact?: boolean
}) {
    const current = providers?.find((p) => p.name === provider)
    const models = current?.models ?? []
    const className = compact ? 'filter' : undefined
    // One line always: short labels in a header (compact); in a form the two selects share the row's width.
    const grow = compact ? undefined : { flex: 1, minWidth: 0 }
    const claude = aliases ?? [{ value: '', label: inherit }, ...CLAUDE_ALIASES]
    return (
        <span
            className='row'
            style={{ gap: 6, flexWrap: 'nowrap', width: compact ? undefined : '100%' }}
        >
            <select
                className={className}
                style={grow}
                value={provider}
                disabled={disabled}
                aria-label='Provider'
                onChange={(e) => onChange(e.target.value, '')}
            >
                <option value=''>Claude subscription</option>
                {provider && !current && <option value={provider}>{provider} (missing)</option>}
                {(providers ?? []).map((p) => (
                    <option
                        key={p.name}
                        value={p.name}
                    >
                        {p.name}
                        {p.light ? '' : ' (full prompt)'}
                    </option>
                ))}
            </select>
            {provider ? (
                <select
                    className={className}
                    style={grow}
                    value={model}
                    disabled={disabled}
                    aria-label='Model'
                    onChange={(e) => onChange(provider, e.target.value)}
                >
                    <option value=''>{current?.default ? `default — ${current.default}` : 'default'}</option>
                    {model && !models.includes(model) && <option value={model}>{model}</option>}
                    {models.map((m) => (
                        <option
                            key={m}
                            value={m}
                        >
                            {m}
                        </option>
                    ))}
                </select>
            ) : (
                <select
                    className={className}
                    style={grow}
                    value={model}
                    disabled={disabled}
                    aria-label='Model'
                    onChange={(e) => onChange('', e.target.value)}
                >
                    {model && !claude.some((a) => a.value === model) && <option value={model}>{model}</option>}
                    {claude.map((a) => (
                        <option
                            key={a.value}
                            value={a.value}
                        >
                            {compact ? a.value || 'factory model' : a.label}
                        </option>
                    ))}
                </select>
            )}
        </span>
    )
}

/** The outcome of one probe request, next to the button that sent it. */
function TestProvider({ draft, model }: { draft: Partial<Provider>; model?: string }) {
    const [state, setState] = useState<{ busy: boolean; result: ProviderTest | null; error: string | null }>({
        busy: false,
        result: null,
        error: null
    })
    const ready = Boolean(draft.url?.trim() || (draft.name && !draft.url))
    const run = async () => {
        setState({ busy: true, result: null, error: null })
        try {
            setState({ busy: false, result: await api.testProvider({ ...draft, model }), error: null })
        } catch (e) {
            setState({ busy: false, result: null, error: (e as Error).message })
        }
    }
    const r = state.result
    return (
        <>
            <Button
                size='sm'
                onClick={() => void run()}
                disabled={state.busy || !ready}
                title='One request with a tool offered and asked for: the endpoint answers, the key works, the model calls tools'
            >
                {state.busy ? 'Testing…' : 'Test'}
            </Button>
            {r?.ok && r.tool_calling && (
                <span className='badge done'>
                    {r.model} · tool calling ok · {r.ms} ms
                </span>
            )}
            {r?.ok && !r.tool_calling && (
                <span
                    className='badge failed'
                    title={r.output || 'the model answered in prose instead of calling the tool'}
                >
                    {r.model} answers, but did not call the tool
                </span>
            )}
            {r && !r.ok && (
                <span
                    className='badge failed'
                    title={r.error}
                >
                    failed
                </span>
            )}
            {(r?.error || state.error) && (
                <code
                    className='host-output'
                    title={r?.error ?? state.error ?? ''}
                >
                    {(r?.error ?? state.error ?? '').split('\n').at(-1)}
                </code>
            )}
        </>
    )
}

export function ProviderDialog({
    open,
    initial,
    editing,
    taken = [],
    onClose,
    onSaved
}: {
    open: boolean
    initial?: Partial<Provider>
    /** The saved name of the provider being edited; absent when creating. */
    editing?: string
    taken?: string[]
    onClose: () => void
    onSaved: (provider: Provider) => void
}) {
    const [p, setP] = useState<Provider>({ ...EMPTY, ...initial })
    const [models, setModels] = useState('')
    const [busy, setBusy] = useState(false)
    const [fetching, setFetching] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (open) {
            setP({ ...EMPTY, ...initial })
            setModels((initial?.models ?? []).join('\n'))
            setError(null)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])
    const set = (patch: Partial<Provider>) => setP((prev) => ({ ...prev, ...patch }))
    const list = models
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean)
    const draft: Provider = { ...p, models: list }
    const nameTaken = taken.includes(p.name.trim()) && p.name.trim() !== editing
    const fetchModels = async () => {
        setFetching(true)
        setError(null)
        try {
            const { models: ids } = await api.providerModels({ kind: p.kind, url: p.url, token: p.token })
            setModels(ids.join('\n'))
            if (!ids.length) setError('the endpoint lists no models')
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setFetching(false)
        }
    }
    const save = async () => {
        const name = p.name.trim()
        if (!name || !p.url.trim() || !list.length) {
            setError('a name, a URL and at least one model are required')
            return
        }
        if (nameTaken) return
        setBusy(true)
        try {
            const saved = await api.saveProvider(
                editing ?? name,
                {
                    name,
                    kind: p.kind,
                    url: p.url.trim(),
                    token: p.token?.trim() || undefined,
                    models: list,
                    default: p.default || undefined,
                    small: p.small?.trim() || undefined,
                    concurrency: p.concurrency,
                    light: p.light
                },
                !editing
            )
            setError(null)
            onSaved(saved)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={editing ? `Provider ${editing}` : 'Add provider'}
            icon='limits'
            size='wide'
            description='A self-hosted model or a cloud API the tasks can run on instead of the subscription. The key stays in .env: name the variable here.'
            busy={busy}
            footer={
                <>
                    <span className='modal-foot-aside'>
                        <TestProvider
                            draft={draft}
                            model={p.default || list[0]}
                        />
                    </span>
                    <Button
                        onClick={onClose}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant='primary'
                        onClick={save}
                        disabled={busy || !p.name.trim() || !p.url.trim() || !list.length || nameTaken}
                    >
                        {busy ? 'Saving…' : editing ? 'Save' : 'Save provider'}
                    </Button>
                </>
            }
        >
            <div className='stack'>
                <div className='form-grid'>
                    <label className='field'>
                        <span>Name</span>
                        <input
                            value={p.name}
                            autoFocus
                            placeholder='lookatstars'
                            onChange={(e) => set({ name: e.target.value })}
                        />
                        <span className='dim'>used in files as provider: name, and as provider:model</span>
                    </label>
                    <label className='field'>
                        <span>API</span>
                        <select
                            value={p.kind}
                            onChange={(e) => set({ kind: e.target.value as Provider['kind'] })}
                        >
                            <option value='anthropic'>Anthropic Messages (Ollama, llama.cpp, vLLM, OpenRouter)</option>
                            <option value='openai'>OpenAI chat completions (OpenAI, Gemini, Groq, LM Studio)</option>
                        </select>
                        <span className='dim'>what the endpoint speaks; the factory translates the second</span>
                    </label>
                    <label className='field wide'>
                        <span>URL</span>
                        <input
                            className='mono'
                            value={p.url}
                            placeholder={
                                p.kind === 'openai'
                                    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
                                    : 'http://10.77.0.1:11434'
                            }
                            onChange={(e) => set({ url: e.target.value })}
                        />
                        <span className='dim'>
                            {p.kind === 'openai'
                                ? 'up to (not including) /chat/completions'
                                : 'up to (not including) /v1/messages'}
                        </span>
                    </label>
                    <label className='field'>
                        <span>Key variable</span>
                        <input
                            className='mono'
                            value={p.token ?? ''}
                            placeholder='GEMINI_API_KEY'
                            onChange={(e) => set({ token: e.target.value.toUpperCase() })}
                        />
                        <span className='dim'>the name in .env, never the key; empty for a server without one</span>
                    </label>
                    <label className='field'>
                        <span>Tasks at once</span>
                        <input
                            type='number'
                            min={0}
                            max={64}
                            value={p.concurrency}
                            onChange={(e) => set({ concurrency: Math.max(0, Number(e.target.value) || 0) })}
                        />
                        <span className='dim'>1 for one GPU; 0 = no limit (cloud)</span>
                    </label>
                    <label className='field wide'>
                        <span className='row between'>
                            <span>Models</span>
                            <Button
                                size='sm'
                                onClick={() => void fetchModels()}
                                disabled={fetching || !p.url.trim()}
                                title='GET /v1/models'
                            >
                                {fetching ? 'Fetching…' : 'Fetch from the endpoint'}
                            </Button>
                        </span>
                        <textarea
                            className='mono'
                            rows={4}
                            value={models}
                            placeholder={'gemma4:12b\nqwen3.5:9b'}
                            onChange={(e) => setModels(e.target.value)}
                        />
                        <span className='dim'>
                            one per line (or comma separated); the form offers these, any id can still be typed in a
                            file
                        </span>
                    </label>
                    <label className='field'>
                        <span>Default model</span>
                        <select
                            value={list.includes(p.default ?? '') ? p.default : ''}
                            onChange={(e) => set({ default: e.target.value })}
                        >
                            <option value=''>{list[0] ? `first — ${list[0]}` : 'first'}</option>
                            {list.map((m) => (
                                <option
                                    key={m}
                                    value={m}
                                >
                                    {m}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='field'>
                        <span>Small model</span>
                        <input
                            className='mono'
                            value={p.small ?? ''}
                            placeholder='same as the task'
                            onChange={(e) => set({ small: e.target.value })}
                        />
                        <span className='dim'>where the CLI's own small calls (the haiku tier) go</span>
                    </label>
                    <div className='field wide group'>
                        <span>Prompt</span>
                        <label
                            className='row'
                            style={{ gap: 8 }}
                        >
                            <input
                                type='checkbox'
                                checked={p.light}
                                onChange={(e) => set({ light: e.target.checked })}
                            />
                            <span>light mode — a short system prompt and a few tools</span>
                        </label>
                        <span className='dim'>
                            the system prompt is the agent file's body (a schedule's agent), else
                            data/claude/light-system.md; tools Read / Write / Edit / Bash / Glob / Grep, no skills or
                            connectors; models under ~30B need it, a frontier model can take the full prompt
                        </span>
                    </div>
                </div>
                {nameTaken && (
                    <div className='error small'>{`A provider named "${p.name.trim()}" already exists — pick another name, or open it from the list.`}</div>
                )}
                {error && <div className='error small'>{error}</div>}
            </div>
        </Modal>
    )
}

// ---- Settings → Providers ---------------------------------------------------

export function ProvidersSection() {
    const data = useAsync(() => api.providers(), [], 30_000)
    const [dialog, setDialog] = useState<{ editing?: ProviderView } | null>(null)
    const confirm = useConfirm()
    const overview = data.data

    const remove = (p: ProviderView) =>
        void confirm({
            title: `Delete provider ${p.name}?`,
            message: p.used_by.length
                ? `${p.used_by.join(', ')} name it; their next runs fail until they pick another. The server itself is not touched.`
                : 'It leaves the list; the server itself is not touched.',
            action: 'Delete',
            pending: 'Deleting…',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.deleteProvider(p.name, true)
                data.reload()
            }
        })

    return (
        <div className='stack'>
            {data.error && <div className='error small'>{data.error}</div>}
            {overview?.error && (
                <div className='error small'>
                    The file on disk is not valid YAML ({overview.error}); saving a provider replaces it.
                </div>
            )}
            <div className='row between wrap'>
                <span className='dim small'>
                    {overview
                        ? overview.providers.length
                            ? `${overview.providers.length} provider${overview.providers.length === 1 ? '' : 's'} besides the subscription`
                            : 'No other providers yet'
                        : 'Loading…'}{' '}
                    · a task runs on one when its schedule, its chat or the agent it runs as says so; keys stay in .env
                    and go out only from the factory's gateway
                </span>
                <Button
                    size='sm'
                    variant='primary'
                    onClick={() => setDialog({})}
                >
                    Add provider
                </Button>
            </div>
            <div className='host-list'>
                <div className='host-row'>
                    <span className='host-id'>
                        <strong>claude</strong>
                        <span className='dim small'>the subscription — built in</span>
                    </span>
                    <span className='host-projects'>
                        <span className='dim small'>every task unless told otherwise</span>
                    </span>
                    <span className='host-actions' />
                </div>
                {overview?.providers.map((p) => (
                    <div
                        key={p.name}
                        className='host-row'
                    >
                        <span className='host-id'>
                            <strong>{p.name}</strong>
                            <span className='mono dim small'>{p.url}</span>
                            <span className='badge plain'>{p.kind === 'openai' ? 'OpenAI API' : 'Messages API'}</span>
                            {p.light && <span className='badge plain'>light</span>}
                            {p.token && (
                                <span
                                    className={`badge ${p.token_set ? 'plain' : 'failed'}`}
                                    title={p.token_set ? `${p.token} is set in .env` : `${p.token} is not set in .env`}
                                >
                                    {p.token}
                                    {p.token_set ? '' : ' missing'}
                                </span>
                            )}
                            {p.health?.ok === false && (
                                <span
                                    className='badge failed'
                                    title={p.health.error ?? ''}
                                >
                                    last request failed
                                </span>
                            )}
                            {p.running > 0 && <span className='badge running'>{p.running} running</span>}
                        </span>
                        <span className='host-projects'>
                            <span
                                className='dim small'
                                title={p.models.join(', ')}
                            >
                                {p.models.slice(0, 3).join(', ')}
                                {p.models.length > 3 ? ` +${p.models.length - 3}` : ''}
                            </span>
                            {p.used_by.map((u) => (
                                <span
                                    key={u}
                                    className='badge plain'
                                >
                                    {u}
                                </span>
                            ))}
                        </span>
                        <span className='host-actions'>
                            <TestProvider draft={{ name: p.name }} />
                            <Button
                                size='sm'
                                onClick={() => setDialog({ editing: p })}
                            >
                                Edit
                            </Button>
                            <Button
                                size='sm'
                                variant='danger'
                                onClick={() => remove(p)}
                            >
                                Delete
                            </Button>
                        </span>
                    </div>
                ))}
            </div>
            <ProviderDialog
                open={dialog !== null}
                initial={dialog?.editing}
                editing={dialog?.editing?.name}
                taken={overview?.providers.map((p) => p.name) ?? []}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null)
                    data.reload()
                }}
            />
        </div>
    )
}

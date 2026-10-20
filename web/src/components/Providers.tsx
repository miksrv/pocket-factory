import { useEffect, useState } from 'react'

import { api, type Provider, type ProviderMcp, type ProviderTest, type ProviderView, type VaultEntry } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { CodeEditor } from './CodeEditor'
import { Icon } from './Icon'
import { Modal, useConfirm } from './Modal'
import { SecretDialog } from './Secrets'
import { Button, ErrorBox, SectionHead } from './ui'

/**
 * Model providers besides the subscription: self-hosted models (Ollama on a
 * GPU box, llama.cpp, vLLM) and cloud APIs (OpenRouter, Gemini, OpenAI, Groq).
 * The list lives in Settings → Providers (`data/config/providers.yaml`); an
 * agent, a routine or a chat picks one with `ModelPicker`. A key is a secret
 * of Settings → Secrets with the access "model providers only": the form picks
 * one or adds it, the gateway alone reads it, no run gets it.
 */

export const CLAUDE_ALIASES: Array<{ value: string; label: string }> = [
    { value: 'sonnet', label: 'sonnet — current Sonnet' },
    { value: 'opus', label: 'opus — current Opus' },
    { value: 'haiku', label: 'haiku — current Haiku' },
    { value: 'fable', label: 'fable — current Fable (Max plans)' }
]

/** The name a new key is offered under: `UNOROUTER_API_KEY`, `BOX_SEARCH_TOKEN`. */
function defaultTokenVar(provider: string, mcp?: string): string {
    const part = (s: string) =>
        s
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
    const base = part(provider || 'provider')
    const head = /^[A-Z]/.test(base) ? base : `P_${base}`
    return mcp ? `${head}_${part(mcp)}_TOKEN` : `${head}_API_KEY`
}

/**
 * A provider's key: one of the provider keys in Settings → Secrets, or New secret (the same window
 * as everywhere, its access fixed to "model providers only"). A name no provider key holds stays
 * in the list as missing, so a file's `token:` is never dropped silently.
 */
function KeyPicker({
    value,
    onChange,
    keys,
    suggest,
    label,
    onAdded
}: {
    value: string
    onChange: (name: string) => void
    keys: VaultEntry[] | undefined
    /** The name New secret offers. */
    suggest: string
    label: string
    onAdded: () => void
}) {
    const [adding, setAdding] = useState(false)
    const names = (keys ?? []).filter((k) => k.provider).map((k) => k.name)
    const missing = value && keys && !names.includes(value)
    return (
        <span
            className='row'
            style={{ gap: 6, flexWrap: 'nowrap', flex: 1, minWidth: 0 }}
        >
            <select
                className='mono'
                style={{ flex: 1, minWidth: 0 }}
                value={value}
                aria-label={label}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value=''>none</option>
                {names.map((n) => (
                    <option
                        key={n}
                        value={n}
                    >
                        {n}
                    </option>
                ))}
                {missing && <option value={value}>{value} — not in Secrets</option>}
            </select>
            <Button
                onClick={() => setAdding(true)}
                title='A new secret with the access "model providers only"'
            >
                New secret
            </Button>
            <SecretDialog
                open={adding}
                kind='secret'
                provider
                name={missing ? value : names.includes(suggest) ? undefined : suggest}
                onClose={() => setAdding(false)}
                onSaved={(entry) => {
                    setAdding(false)
                    onChange(entry.name)
                    onAdded()
                }}
            />
        </span>
    )
}

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
            {r?.mcp?.map((m) => (
                <span
                    key={m.name}
                    className={`badge ${m.ok ? 'done' : 'failed'}`}
                    title={m.ok ? (m.server ?? '') : (m.error ?? '')}
                >
                    MCP {m.name} {m.ok ? 'ok' : 'failed'}
                </span>
            ))}
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

/** The provider's own MCP servers: name, URL and the bearer (a provider key in Secrets), one row each. */
function McpRows({
    rows,
    onChange,
    provider,
    keys,
    onAdded
}: {
    rows: ProviderMcp[]
    onChange: (rows: ProviderMcp[]) => void
    provider: string
    keys: VaultEntry[] | undefined
    onAdded: () => void
}) {
    const set = (i: number, patch: Partial<ProviderMcp>) =>
        onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    return (
        <div className='field wide group section'>
            <SectionHead
                title='MCP servers'
                hint="HTTP servers for this provider's tasks only; the gateway adds the key"
            >
                <Button
                    size='sm'
                    onClick={() => onChange([...rows, { name: '', url: '', token: '' }])}
                >
                    <Icon
                        name='add'
                        size={12}
                    />
                    MCP server
                </Button>
            </SectionHead>
            {rows.map((r, i) => (
                <span
                    key={i}
                    className='row'
                    style={{ gap: 6, flexWrap: 'nowrap' }}
                >
                    <input
                        className='mono'
                        style={{ flex: '0 0 22%', minWidth: 0 }}
                        value={r.name}
                        placeholder='search'
                        aria-label='MCP server name'
                        onChange={(e) => set(i, { name: e.target.value })}
                    />
                    <input
                        className='mono'
                        style={{ flex: 1, minWidth: 0 }}
                        value={r.url}
                        placeholder='https://203.0.113.10:8443/mcp'
                        aria-label='MCP server URL'
                        onChange={(e) => set(i, { url: e.target.value })}
                    />
                    <span style={{ flex: '0 0 38%', minWidth: 0, display: 'flex' }}>
                        <KeyPicker
                            value={r.token ?? ''}
                            onChange={(token) => set(i, { token })}
                            keys={keys}
                            suggest={defaultTokenVar(provider, r.name || 'mcp')}
                            label='MCP server key'
                            onAdded={onAdded}
                        />
                    </span>
                    <Button
                        variant='danger'
                        onClick={() => onChange(rows.filter((_, j) => j !== i))}
                    >
                        Remove
                    </Button>
                </span>
            ))}
        </div>
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
    initial?: Partial<ProviderView>
    /** The saved name of the provider being edited; absent when creating. */
    editing?: string
    taken?: string[]
    onClose: () => void
    onSaved: (provider: Provider) => void
}) {
    const [p, setP] = useState<Provider>({ ...EMPTY, ...initial, mcp: undefined })
    // The provider keys to pick from (Settings → Secrets, access "model providers only").
    const vault = useAsync(() => (open ? api.secrets() : Promise.resolve(null)), [open])
    const keys = vault.data?.entries
    const [mcp, setMcp] = useState<ProviderMcp[]>([])
    /** A pasted PEM to trust; '' = untouched. `dropCa` removes the saved one. */
    const [ca, setCa] = useState('')
    const [dropCa, setDropCa] = useState(false)
    const [models, setModels] = useState('')
    const [busy, setBusy] = useState(false)
    const [fetching, setFetching] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (open) {
            setP({ ...EMPTY, ...initial, mcp: undefined })
            setModels((initial?.models ?? []).join('\n'))
            setMcp((initial?.mcp ?? []).map(({ name, url, token }) => ({ name, url, token })))
            setCa('')
            setDropCa(false)
            setError(null)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])
    const set = (patch: Partial<Provider>) => setP((prev) => ({ ...prev, ...patch }))
    const list = models
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean)
    const servers = mcp
        .map((m) => ({ name: m.name.trim(), url: m.url.trim(), token: m.token?.trim() || undefined }))
        .filter((m) => m.name || m.url)
    const draft: Provider = { ...p, models: list, mcp: servers }
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
                    light: p.light,
                    max_output: p.max_output || undefined,
                    context: p.context || undefined,
                    mcp: servers,
                    ca: ca.trim() ? ca : dropCa ? null : undefined
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
            icon='provider'
            size='wide'
            description='A model server or cloud API off the subscription; its key is a secret only the gateway reads.'
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
                    <div className='field wide'>
                        <SectionHead title='Connection' />
                    </div>
                    <label className='field'>
                        <span>Name</span>
                        <input
                            value={p.name}
                            autoFocus
                            placeholder='gpu-box'
                            onChange={(e) => set({ name: e.target.value })}
                        />
                        <span className='dim'>as provider: name in files</span>
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
                        <span className='dim'>the factory translates OpenAI</span>
                    </label>
                    <label className='field'>
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
                            {p.kind === 'openai' ? 'up to /chat/completions' : 'up to /v1/messages'}
                        </span>
                    </label>
                    <div className='field'>
                        <span>API key</span>
                        <KeyPicker
                            value={p.token ?? ''}
                            onChange={(token) => set({ token })}
                            keys={keys}
                            suggest={defaultTokenVar(p.name)}
                            label='API key'
                            onAdded={vault.reload}
                        />
                        <span className='dim'>a secret for model providers; none for a local server</span>
                    </div>
                    <div className='field wide group section'>
                        <SectionHead
                            title='Models'
                            hint='One per line; any other id can still be typed in a file'
                        >
                            <Button
                                size='sm'
                                onClick={() => void fetchModels()}
                                disabled={fetching || !p.url.trim()}
                                title='GET /v1/models'
                            >
                                {fetching ? 'Fetching…' : 'Fetch from the endpoint'}
                            </Button>
                        </SectionHead>
                        <textarea
                            className='mono'
                            rows={4}
                            value={models}
                            aria-label='Models'
                            placeholder={'gemma4:12b\nqwen3.5:9b'}
                            onChange={(e) => setModels(e.target.value)}
                        />
                    </div>
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
                        <span className='dim'>for the CLI's haiku-tier calls</span>
                    </label>
                    <label className='field'>
                        <span>Context window (tokens)</span>
                        <input
                            type='number'
                            min={8000}
                            step={1000}
                            value={p.context ?? ''}
                            placeholder="the CLI's assumption"
                            onChange={(e) => set({ context: e.target.value ? Number(e.target.value) : undefined })}
                        />
                        <span className='dim'>the real one (Ollama: num_ctx)</span>
                    </label>
                    <label className='field'>
                        <span>Output per call (tokens)</span>
                        <input
                            type='number'
                            min={1}
                            max={32000}
                            step={1000}
                            value={p.max_output ?? ''}
                            placeholder='8000'
                            onChange={(e) => set({ max_output: e.target.value ? Number(e.target.value) : undefined })}
                        />
                        <span className='dim'>stops a looping model</span>
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
                    <div className='field wide group section'>
                        <SectionHead
                            title='Prompt'
                            hint='Models under ~30B need light mode'
                        />
                        <label
                            className='row'
                            style={{ gap: 8 }}
                            title="A short system prompt (the agent's body or light-system.md) and six built-in tools"
                        >
                            <input
                                type='checkbox'
                                checked={p.light}
                                onChange={(e) => set({ light: e.target.checked })}
                            />
                            <span>Light mode</span>
                        </label>
                    </div>
                    <div className='field wide group section'>
                        <SectionHead
                            title='TLS certificate'
                            hint='A self-signed box only: its CA, trusted at once'
                        />
                        {initial?.ca && !dropCa && !ca.trim() && (
                            <span
                                className='row'
                                style={{ gap: 8 }}
                            >
                                <span className='badge done'>trusted</span>
                                <span
                                    className='mono dim small'
                                    title={`${initial.ca.fingerprint} · valid to ${initial.ca.valid_to.slice(0, 10)}`}
                                >
                                    {initial.ca.subject}
                                </span>
                                <Button
                                    size='sm'
                                    variant='danger'
                                    onClick={() => setDropCa(true)}
                                >
                                    Remove
                                </Button>
                            </span>
                        )}
                        <CodeEditor
                            path='ca.pem'
                            label='CA certificate'
                            rows={4}
                            value={ca}
                            placeholder={
                                initial?.ca && !dropCa
                                    ? 'paste another CA certificate to replace it'
                                    : '-----BEGIN CERTIFICATE-----  (empty for a public certificate)'
                            }
                            onChange={setCa}
                        />
                    </div>
                    <McpRows
                        provider={p.name}
                        keys={keys}
                        onAdded={vault.reload}
                        rows={mcp}
                        onChange={setMcp}
                    />
                </div>
                {nameTaken && (
                    <ErrorBox
                        inline
                        error={`A provider named "${p.name.trim()}" already exists — pick another name, or open it from the list.`}
                    />
                )}
                <ErrorBox
                    error={error}
                    inline
                />
            </div>
        </Modal>
    )
}

// ---- Settings → Providers ---------------------------------------------------

/**
 * An MCP server's tools in words: `mcp__search__searxng_web_search` → `web search`.
 * The server prefix goes, and so does a prefix every tool shares (`searxng_`).
 */
export function toolNames(server: string, tools: string[]): string[] {
    const bare = tools.map((t) => t.replace(new RegExp(`^mcp__${server}__`), ''))
    const words = bare.map((t) => t.split('_'))
    let shared = 0
    while (words.length > 1 && words.every((w) => w.length > shared + 1 && w[shared] === words[0][shared])) shared++
    return words.map((w) => w.slice(shared).join(' '))
}

export function ProvidersSection() {
    const data = useAsync(() => api.providers(), [], 30_000)
    // The tools each provider's MCP servers offered to their sessions, under the full names an agent file uses.
    const known = useAsync(() => api.tools(), [], 60_000)
    const toolsOf = (server: string) => known.data?.mcp.find((e) => e.server === server)?.tools ?? []
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
            <ErrorBox error={data.error} />
            {overview?.error && (
                <ErrorBox
                    inline
                    error={`The file on disk is not valid YAML (${overview.error}); saving a provider replaces it.`}
                />
            )}
            <div className='row between wrap'>
                <span
                    className='dim small'
                    title='Edit sets the endpoint, models and MCP; a routine, a chat or an agent picks one'
                >
                    {overview
                        ? overview.providers.length
                            ? `${overview.providers.length} provider${overview.providers.length === 1 ? '' : 's'} besides the subscription`
                            : 'No other providers yet'
                        : 'Loading…'}{' '}
                    · keys live in Secrets
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
                                    title={
                                        p.token_set
                                            ? `${p.token}: a secret for model providers`
                                            : `${p.token} is not in Secrets: pick or add the key in the provider`
                                    }
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
                            {p.ca && (
                                <span
                                    className='badge plain'
                                    title={`${p.ca.subject} · ${p.ca.fingerprint}`}
                                >
                                    own CA
                                </span>
                            )}
                            {p.mcp?.map((m) => {
                                const tools = toolsOf(m.name)
                                const names = toolNames(m.name, tools)
                                return (
                                    <span
                                        key={m.name}
                                        className={`badge ${m.token_set ? 'plain' : 'failed'}`}
                                        title={[
                                            m.token_set
                                                ? m.url
                                                : `${m.token} is not in Secrets: pick or add the key in the provider`,
                                            names.length
                                                ? `Tools: ${names.join(', ')}`
                                                : 'Its tools show up after the first task on this provider',
                                            `An agent file lists mcp__${m.name} to get them all`
                                        ].join('\n')}
                                    >
                                        MCP {m.name}
                                        {tools.length ? ` · ${tools.length} tools` : ''}
                                        {m.token_set ? '' : ' · key missing'}
                                    </span>
                                )
                            })}
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

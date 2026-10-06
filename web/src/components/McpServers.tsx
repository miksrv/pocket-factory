import { useEffect, useState } from 'react'

import { type McpServerConfig, type McpStatus } from '../lib/api'
import { Button, CloseButton } from './ui'

/**
 * The one editor for a set of MCP servers, used by Settings (the owner's
 * `data/config/mcp.json`, every session) and by the agent form (`mcpServers:`
 * in the role's frontmatter, that sub-agent only). Controlled by a
 * `Record<name, config>`: every edit reports the whole set through `onChange`;
 * a value that differs from what the field last reported (a poll, a save, a
 * file the agent rewrote) replaces the drafts. Header / env values the API
 * withheld read `<kept>` and stay so unless replaced.
 */

/** `kept`: the API withheld this value, so an emptied field means "keep what is stored", not "clear it". */
type Pair = { k: string; v: string; kept?: boolean }
interface Draft {
    name: string
    type: 'http' | 'sse' | 'stdio'
    url: string
    command: string
    args: string
    headers: Pair[]
    env: Pair[]
}

const KEPT = '<kept>'
const isRef = (v: string) => /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/.test(v)
const pairs = (record?: Record<string, string>): Pair[] =>
    Object.entries(record ?? {}).map(([k, v]) => ({ k, v, kept: v === KEPT }))
const record = (list: Pair[]): Record<string, string> | undefined => {
    const entries = list.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v] as const)
    return entries.length ? Object.fromEntries(entries) : undefined
}
const toDraft = (name: string, c: McpServerConfig): Draft => ({
    name,
    type: c.type ?? (c.command ? 'stdio' : 'http'),
    url: c.url ?? '',
    command: c.command ?? '',
    args: (c.args ?? []).join(' '),
    headers: pairs(c.headers),
    env: pairs(c.env)
})
const fromDraft = (d: Draft): McpServerConfig =>
    d.type === 'stdio'
        ? {
              type: 'stdio',
              command: d.command,
              args: d.args.trim() ? d.args.trim().split(/\s+/) : undefined,
              env: record(d.env)
          }
        : { type: d.type, url: d.url, headers: record(d.headers), env: record(d.env) }
const draftsOf = (config: Record<string, McpServerConfig>): Draft[] =>
    Object.entries(config).map(([name, c]) => toDraft(name, c))
const configOf = (drafts: Draft[]): Record<string, McpServerConfig> =>
    Object.fromEntries(drafts.map((d) => [d.name.trim(), fromDraft(d)]))
const stamp = (config: Record<string, McpServerConfig>) => JSON.stringify(config)

/** The `mcpServers` object of a pasted JSON, or the object itself when it has no wrapper. */
function parseServers(text: string): Record<string, McpServerConfig> {
    const parsed = JSON.parse(text) as
        { mcpServers?: Record<string, McpServerConfig> } | Record<string, McpServerConfig>
    if (!parsed || typeof parsed !== 'object') throw new Error('expected an object')
    return (
        'mcpServers' in parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
            ? parsed.mcpServers
            : parsed
    ) as Record<string, McpServerConfig>
}

export function McpServersField({
    value,
    onChange,
    status,
    empty = 'No servers. Add one: an HTTP server needs a URL, a stdio server a command; secrets only as ${VAR} with the value in .env.',
    expandsVars = true
}: {
    value: Record<string, McpServerConfig>
    onChange: (servers: Record<string, McpServerConfig>) => void
    /** What the last session reported per server, when known. */
    status?: McpStatus[] | null
    empty?: string
    /** The target file expands `${VAR}` (mcp.json does, an agent file does not): literal header / env values are flagged only then. */
    expandsVars?: boolean
}) {
    const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(value))
    // What the field last reported (or was seeded with): a value equal to it is our own echo, anything else replaces the drafts.
    const [reported, setReported] = useState(() => stamp(value))
    const [json, setJson] = useState<string | null>(null)
    const [jsonError, setJsonError] = useState<string | null>(null)

    useEffect(() => {
        const fresh = stamp(value)
        if (fresh === reported) return
        setDrafts(draftsOf(value))
        setReported(fresh)
        setJson(null)
        setJsonError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value])

    const emit = (next: Draft[]) => {
        setDrafts(next)
        const config = configOf(next)
        setReported(stamp(config))
        onChange(config)
    }
    const update = (i: number, patch: Partial<Draft>) => emit(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)))
    const add = () =>
        emit([...drafts, { name: '', type: 'http', url: '', command: '', args: '', headers: [], env: [] }])
    const remove = (i: number) => emit(drafts.filter((_, j) => j !== i))

    const toggleJson = () => {
        if (json === null) {
            setJson(JSON.stringify({ mcpServers: configOf(drafts) }, null, 2))
            setJsonError(null)
        } else if (!jsonError) {
            setJson(null)
        }
    }
    /** JSON edits reach the parent as soon as they parse; an unparsable text keeps the last good set and shows why. */
    const editJson = (text: string) => {
        setJson(text)
        try {
            const config = parseServers(text)
            setJsonError(null)
            setDrafts(draftsOf(config))
            setReported(stamp(config))
            onChange(config)
        } catch (e) {
            setJsonError((e as Error).message)
        }
    }

    return (
        <div className='stack'>
            <div className='row wrap'>
                <Button
                    size='sm'
                    onClick={toggleJson}
                    disabled={json !== null && Boolean(jsonError)}
                >
                    {json === null ? 'Edit as JSON' : 'Back to the form'}
                </Button>
                <Button
                    size='sm'
                    onClick={add}
                    disabled={json !== null}
                >
                    Add server
                </Button>
            </div>
            {json !== null ? (
                <>
                    <textarea
                        className='mono'
                        value={json}
                        onChange={(e) => editJson(e.target.value)}
                        rows={12}
                        spellCheck={false}
                    />
                    {jsonError && <div className='error small'>JSON: {jsonError}</div>}
                </>
            ) : drafts.length === 0 ? (
                <div className='dim small'>{empty}</div>
            ) : (
                drafts.map((d, i) => (
                    <McpCard
                        key={i}
                        draft={d}
                        status={status?.find((s) => s.name === d.name)}
                        expandsVars={expandsVars}
                        onChange={(patch) => update(i, patch)}
                        onRemove={() => remove(i)}
                    />
                ))
            )}
        </div>
    )
}

function McpCard({
    draft,
    status,
    expandsVars,
    onChange,
    onRemove
}: {
    draft: Draft
    status: McpStatus | undefined
    expandsVars: boolean
    onChange: (patch: Partial<Draft>) => void
    onRemove: () => void
}) {
    const envHint = expandsVars
        ? 'API_KEY = ${MY_API_KEY}'
        : 'paths and flags only — no ${VAR} here; the server inherits .env'
    const tone = (s: string) =>
        s === 'connected' ? 'done' : s === 'needs-auth' ? 'queued' : s === 'failed' ? 'failed' : 'cancelled'
    return (
        <div className='host-card'>
            <label className='field'>
                <span>Name</span>
                <input
                    className='mono'
                    placeholder='trac'
                    value={draft.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                />
            </label>
            <label className='field'>
                <span>Type</span>
                <select
                    value={draft.type}
                    onChange={(e) => onChange({ type: e.target.value as Draft['type'] })}
                >
                    <option value='http'>http (remote)</option>
                    <option value='sse'>sse (remote, legacy)</option>
                    <option value='stdio'>stdio (a command in the container)</option>
                </select>
            </label>
            {draft.type === 'stdio' ? (
                <>
                    <label className='field'>
                        <span>Command</span>
                        <input
                            className='mono'
                            placeholder='npx'
                            value={draft.command}
                            onChange={(e) => onChange({ command: e.target.value })}
                        />
                    </label>
                    <label className='field'>
                        <span>Arguments</span>
                        <input
                            className='mono'
                            placeholder='-y @example/mcp-server'
                            value={draft.args}
                            onChange={(e) => onChange({ args: e.target.value })}
                        />
                    </label>
                </>
            ) : (
                <label
                    className='field'
                    style={{ gridColumn: 'span 2' }}
                >
                    <span>URL</span>
                    <input
                        className='mono'
                        placeholder='https://mcp.example.com/mcp'
                        value={draft.url}
                        onChange={(e) => onChange({ url: e.target.value })}
                    />
                </label>
            )}
            {draft.type !== 'stdio' && (
                <PairsField
                    label='Headers'
                    hint={expandsVars ? 'Authorization: Bearer ${MY_TOKEN}' : 'no ${VAR} here'}
                    flagLiterals={expandsVars}
                    list={draft.headers}
                    onChange={(headers) => onChange({ headers })}
                />
            )}
            <PairsField
                label='Environment'
                hint={envHint}
                flagLiterals={expandsVars}
                list={draft.env}
                onChange={(env) => onChange({ env })}
            />
            <div className='host-foot wide'>
                {status && <span className={`badge ${tone(status.status)}`}>{status.status} in the last session</span>}
                <span className='grow' />
                <Button
                    size='sm'
                    variant='danger'
                    onClick={onRemove}
                >
                    Remove
                </Button>
            </div>
        </div>
    )
}

/** Key / value rows for headers or env; a literal value that is not a `${VAR}` reference is flagged, a withheld one shows as kept. */
function PairsField({
    label,
    hint,
    flagLiterals,
    list,
    onChange
}: {
    label: string
    hint: string
    flagLiterals: boolean
    list: Pair[]
    onChange: (list: Pair[]) => void
}) {
    const set = (i: number, patch: Partial<Pair>) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)))
    return (
        <div className='field wide'>
            <span>
                {label} <span className='dim'>· {hint}</span>
            </span>
            <div className='pairs'>
                {list.map((p, i) => (
                    <div
                        key={i}
                        className='row'
                    >
                        <input
                            className='mono'
                            style={{ flex: 1 }}
                            placeholder='name'
                            value={p.k}
                            onChange={(e) => set(i, { k: e.target.value })}
                        />
                        <input
                            className='mono'
                            style={{ flex: 2 }}
                            placeholder='${VAR}'
                            value={p.v === KEPT ? '' : p.v}
                            onChange={(e) => set(i, { v: e.target.value || (p.kept ? KEPT : '') })}
                        />
                        {p.v === KEPT ? (
                            <span className='badge plain'>stored value kept</span>
                        ) : flagLiterals && p.v && !isRef(p.v) ? (
                            <span
                                className='badge plain amber'
                                title='A literal value is written to the file in clear; put it in .env and reference it as ${VAR}.'
                            >
                                literal
                            </span>
                        ) : null}
                        <CloseButton
                            label='Remove row'
                            onClick={() => onChange(list.filter((_, j) => j !== i))}
                        />
                    </div>
                ))}
            </div>
            <div>
                <Button
                    size='sm'
                    onClick={() => onChange([...list, { k: '', v: '' }])}
                >
                    Add {label.toLowerCase() === 'headers' ? 'header' : 'variable'}
                </Button>
            </div>
        </div>
    )
}

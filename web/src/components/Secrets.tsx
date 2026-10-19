import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type EnvNeed, fmt, type SecretScope, type VaultEntry, type VaultOverview } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Icon } from './Icon'
import { Modal, useConfirm } from './Modal'
import { Button, Empty, ErrorBox, SectionHead, Tabs } from './ui'

/*
 * Secrets and variables, as GitHub Actions has them: a secret is written and
 * never shown again (a new value replaces it), a variable is plain
 * configuration with its value in sight. Both reach the steps, the sources
 * and the agent of the runs in their scope; secrets are masked in every log.
 */

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const TABS = [
    { value: 'secret', label: 'Secrets' },
    { value: 'variable', label: 'Variables' }
] as const
type EntryKind = (typeof TABS)[number]['value']

export function scopeText(scope: SecretScope): string {
    if (scope.all) return 'every routine and chat'
    const parts = [...scope.routines.map((r) => `routine ${r}`), ...scope.projects.map((p) => `project ${p}`)]
    return parts.length ? parts.join(', ') : 'nothing (no routine or project picked)'
}

/** Settings → Secrets and variables. */
export function SecretsSection() {
    const data = useAsync(() => api.secrets(), [], 30_000)
    const [tab, setTab] = useState<EntryKind>('secret')
    const [dialog, setDialog] = useState<{ editing?: VaultEntry } | null>(null)
    const confirm = useConfirm()
    const entries = (data.data?.entries ?? []).filter((e) => e.secret === (tab === 'secret'))

    const remove = (e: VaultEntry) =>
        void confirm({
            title: `Delete ${e.secret ? 'secret' : 'variable'} ${e.name}?`,
            message: e.used_by.length
                ? `${e.used_by.map((u) => (u.kind === 'routine' ? `${u.name} (${u.step})` : u.name)).join(', ')} read it; their next runs go without it (or with the .env value of the same name).`
                : 'Nothing uses it now. There is no undo: a secret value cannot be read back.',
            action: 'Delete',
            pending: 'Deleting…',
            danger: true,
            icon: 'delete',
            onConfirm: async () => {
                await api.removeSecret(e.name)
                data.reload()
            }
        })

    return (
        <div className='stack'>
            <div className='row between wrap'>
                <Tabs
                    items={TABS}
                    value={tab}
                    onChange={setTab}
                />
                <Button
                    size='sm'
                    variant='primary'
                    onClick={() => setDialog({})}
                >
                    {tab === 'secret' ? 'New secret' : 'New variable'}
                </Button>
            </div>
            <span className='dim small'>
                {tab === 'secret'
                    ? 'Passwords and tokens: written here, never shown again, masked as •••• in runs, logs and Telegram.'
                    : 'Plain settings scripts read (a URL, an id, a login): the value stays visible.'}{' '}
                A step reads them as <span className='mono'>$NAME</span>; a name here wins over .env.
            </span>
            <ErrorBox error={data.error} />
            {data.data && entries.length === 0 && (
                <Empty inline>
                    {tab === 'secret' ? 'No secrets yet.' : 'No variables yet.'} A routine's step card offers Set for
                    what its script needs.
                </Empty>
            )}
            {entries.length > 0 && (
                <div className='vault-list'>
                    {entries.map((e) => (
                        <div
                            key={e.name}
                            className='vault-row'
                        >
                            <span className='vault-name'>
                                <Icon
                                    name={e.secret ? 'secret' : 'variable'}
                                    size={14}
                                />
                                <strong className='mono'>{e.name}</strong>
                                {!e.secret && (
                                    <span
                                        className='mono dim small vault-value'
                                        title={e.value}
                                    >
                                        {e.value}
                                    </span>
                                )}
                            </span>
                            <span
                                className='vault-uses'
                                title={`Reaches ${scopeText(e.scope)}`}
                            >
                                <span className={`badge ${e.scope.all ? 'plain' : 'blue'}`}>
                                    {e.scope.all ? 'all' : 'scoped'}
                                </span>
                                {e.used_by.length === 0 && <span className='dim small'>not used by a step</span>}
                                {e.used_by.map((u, i) =>
                                    u.kind === 'routine' ? (
                                        <Link
                                            key={i}
                                            to={`/routines/${encodeURIComponent(u.name)}`}
                                            className='badge plain'
                                            title={`step ${u.step}`}
                                        >
                                            ⏱ {u.name}
                                        </Link>
                                    ) : (
                                        <span
                                            key={i}
                                            className='badge plain'
                                        >
                                            {u.name}
                                        </span>
                                    )
                                )}
                            </span>
                            <span
                                className='dim small nowrap'
                                title={fmt.when(e.updated_at)}
                            >
                                updated {fmt.ago(e.updated_at)}
                            </span>
                            <span className='vault-actions'>
                                <Button
                                    size='sm'
                                    onClick={() => setDialog({ editing: e })}
                                >
                                    {e.secret ? 'Update' : 'Edit'}
                                </Button>
                                <Button
                                    size='sm'
                                    variant='danger'
                                    onClick={() => remove(e)}
                                >
                                    Delete
                                </Button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <SecretDialog
                open={dialog !== null}
                kind={dialog?.editing ? (dialog.editing.secret ? 'secret' : 'variable') : tab}
                editing={dialog?.editing}
                overview={data.data}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null)
                    data.reload()
                }}
            />
        </div>
    )
}

/**
 * Add or change one secret or variable. A secret's current value is never
 * shown: Update takes a new one, or leaves the value as it is and changes
 * only who may read it. A name given by a step card comes filled in, with
 * that routine as the scope.
 */
export function SecretDialog({
    open,
    kind,
    editing,
    name: presetName,
    routines: asking,
    overview,
    onClose,
    onSaved
}: {
    open: boolean
    kind: EntryKind
    editing?: VaultEntry
    /** A new entry's name, from a step that needs it. */
    name?: string
    /** The routines asking (a step card's, a skill's): a new entry is scoped to them, an existing one gets them added. */
    routines?: string[]
    /** Routines and projects to pick for a scope; fetched when not given. */
    overview?: VaultOverview
    onClose: () => void
    onSaved: (entry: VaultEntry) => void
}) {
    const fetched = useAsync(
        () => (open && !overview ? api.secrets() : Promise.resolve(null)),
        [open, Boolean(overview)]
    )
    const targets = overview ?? fetched.data ?? undefined
    const [name, setName] = useState('')
    const [value, setValue] = useState('')
    const [all, setAll] = useState(true)
    const [routines, setRoutines] = useState<string[]>([])
    const [projects, setProjects] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Every opening starts from the entry (or the step's name and routine), never from the last one typed.
    useEffect(() => {
        if (!open) return
        setName(editing?.name ?? presetName ?? '')
        setValue(editing && !editing.secret ? (editing.value ?? '') : '')
        const ask = asking ?? []
        const scope = editing?.scope ?? (ask.length ? { all: false, routines: ask, projects: [] } : { all: true })
        setAll(scope.all)
        // Opened from a routine's card or a skill ("Allow"): those routines are ticked already.
        setRoutines(scope.all ? [] : [...new Set([...scope.routines, ...ask])])
        setProjects(scope.all ? [] : scope.projects)
        setError(null)
        // `asking` is a fresh array on every render of the caller: its content is what counts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, editing, presetName, (asking ?? []).join(',')])

    const secret = kind === 'secret'
    const trimmed = name.trim()
    const nameError =
        !editing && trimmed && !NAME.test(trimmed) ? 'Capital letters, digits and _, not starting with a digit.' : null
    const needsValue = !editing || !secret
    const canSave = !busy && Boolean(trimmed) && !nameError && (!needsValue || value.length > 0)

    const save = async () => {
        if (!canSave) return
        setBusy(true)
        setError(null)
        try {
            const scope: SecretScope = all ? { all: true } : { all: false, routines, projects }
            const entry = await api.saveSecret(
                trimmed,
                { ...(value || !editing ? { value } : {}), secret, scope },
                !editing
            )
            onSaved(entry)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const toggle = (list: string[], set: (next: string[]) => void, item: string) =>
        set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

    const what = secret ? 'secret' : 'variable'
    return (
        <Modal
            open={open}
            onClose={onClose}
            size='wide'
            icon={secret ? 'secret' : 'variable'}
            busy={busy}
            title={editing ? `${secret ? 'Update' : 'Edit'} ${what} ${editing.name}` : `New ${what}`}
            description={
                secret
                    ? 'Never shown again: runs read it as $NAME, logs show ••••.'
                    : 'A plain value scripts read as $NAME; it stays visible.'
            }
            footer={
                <>
                    <Button
                        onClick={onClose}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant='primary'
                        onClick={() => void save()}
                        disabled={!canSave}
                    >
                        {busy ? 'Saving…' : editing ? `${secret ? 'Update' : 'Save'} ${what}` : `Add ${what}`}
                    </Button>
                </>
            }
        >
            <form
                className='form-grid'
                onSubmit={(e) => {
                    e.preventDefault()
                    void save()
                }}
            >
                <label className='field'>
                    <span>Name</span>
                    <input
                        className='mono'
                        value={name}
                        onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                        placeholder={secret ? 'TRAC_PASSWORD' : 'TRAC_USER'}
                        aria-label='Name'
                        disabled={Boolean(editing)}
                        autoFocus={!editing && !presetName}
                        aria-invalid={Boolean(nameError)}
                        spellCheck={false}
                    />
                    {nameError ? (
                        <span className='error'>{nameError}</span>
                    ) : (
                        <span className='dim'>Capital letters, digits and _.</span>
                    )}
                </label>
                <label className='field wide'>
                    <span>{secret ? (editing ? 'New value' : 'Secret') : 'Value'}</span>
                    <textarea
                        className='mono'
                        rows={secret ? 3 : 2}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                            secret && editing
                                ? 'The current value is hidden. Type a new one to replace it, or leave empty to change only the access.'
                                : secret
                                  ? 'Paste the token or password'
                                  : 'https://trac.example.com'
                        }
                        autoFocus={Boolean(presetName) || Boolean(editing)}
                        autoComplete='off'
                        aria-label={secret ? (editing ? 'New value' : 'Secret') : 'Value'}
                        spellCheck={false}
                        data-secret={secret ? '' : undefined}
                    />
                    <span className='dim'>
                        {secret ? 'Multi-line is fine (a key file); every line is masked.' : 'Up to 64 KB.'}
                    </span>
                </label>
                <div className='field wide group'>
                    <span>Access</span>
                    <label
                        className='row'
                        style={{ gap: 8 }}
                    >
                        <input
                            type='radio'
                            checked={all}
                            onChange={() => setAll(true)}
                        />
                        <span>every routine and chat</span>
                    </label>
                    <label
                        className='row'
                        style={{ gap: 8 }}
                    >
                        <input
                            type='radio'
                            checked={!all}
                            onChange={() => setAll(false)}
                        />
                        <span>only the routines and projects picked</span>
                    </label>
                    {!all && (
                        <div className='vault-scope'>
                            <div className='dim small'>Routines</div>
                            <div className='row wrap'>
                                {(targets?.routines ?? []).map((r) => (
                                    <label
                                        key={r}
                                        className='chip-check'
                                    >
                                        <input
                                            type='checkbox'
                                            checked={routines.includes(r)}
                                            onChange={() => toggle(routines, setRoutines, r)}
                                        />
                                        <span className='mono'>{r}</span>
                                    </label>
                                ))}
                            </div>
                            <div className='dim small'>Projects (their chats and routines)</div>
                            <div className='row wrap'>
                                {(targets?.projects ?? []).map((p) => (
                                    <label
                                        key={p}
                                        className='chip-check'
                                    >
                                        <input
                                            type='checkbox'
                                            checked={projects.includes(p)}
                                            onChange={() => toggle(projects, setProjects, p)}
                                        />
                                        <span className='mono'>{p}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                    <span className='dim'>A chat outside these projects never sees a scoped value.</span>
                </div>
                <ErrorBox error={error} />
            </form>
        </Modal>
    )
}

/**
 * What a step reads from its environment, each name with whether a run of
 * this routine gets it, and Set right there for what is missing.
 */
export function NeedsLine({ needs, routine, onChanged }: { needs: EnvNeed[]; routine: string; onChanged: () => void }) {
    const [dialog, setDialog] = useState<EnvNeed | null>(null)
    const [editing, setEditing] = useState<VaultEntry | undefined>(undefined)
    if (!needs.length) return null
    const open = async (need: EnvNeed) => {
        // A name the vault holds out of this routine's scope opens as an update: widen the access, keep the value.
        if (need.out_of_scope) {
            const overview = await api.secrets()
            setEditing(overview.entries.find((e) => e.name === need.name))
        } else setEditing(undefined)
        setDialog(need)
    }
    return (
        <div className='needs wide'>
            <span className='dim small'>Reads</span>
            {needs.map((n) => {
                const ok = n.from !== null
                const label =
                    n.from === 'secret'
                        ? 'secret'
                        : n.from === 'variable'
                          ? 'variable'
                          : n.from === 'env'
                            ? '.env'
                            : n.out_of_scope
                              ? 'not for this routine'
                              : n.optional
                                ? 'optional'
                                : 'not set'
                return (
                    <span
                        key={n.name}
                        className={`need ${ok ? 'ok' : n.optional ? 'optional' : 'missing'}`}
                    >
                        <Icon
                            name={n.kind === 'secret' ? 'secret' : 'variable'}
                            size={12}
                        />
                        <span className='mono'>{n.name}</span>
                        <span className='need-state'>
                            {ok && (
                                <Icon
                                    name='ok'
                                    size={12}
                                />
                            )}
                            {label}
                        </span>
                        {(n.from === null || n.from === 'env') && (
                            <Button
                                size='sm'
                                variant={!ok && !n.optional ? 'primary' : undefined}
                                className='need-set'
                                onClick={() => void open(n)}
                                title={
                                    n.from === 'env'
                                        ? 'Comes from .env now; set it here to edit it from the UI'
                                        : n.out_of_scope
                                          ? 'Give this routine access to it'
                                          : `Add it as a ${n.kind}`
                                }
                            >
                                {n.out_of_scope ? 'Allow' : 'Set'}
                            </Button>
                        )}
                    </span>
                )
            })}
            <SecretDialog
                open={dialog !== null}
                kind={editing ? (editing.secret ? 'secret' : 'variable') : (dialog?.kind ?? 'secret')}
                editing={editing}
                name={dialog?.name}
                routines={[routine]}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null)
                    onChanged()
                }}
            />
        </div>
    )
}

/**
 * A skill's page: what its scripts read from the environment, name by name,
 * with the files that read it and which of the routines running the skill
 * get it; Set / Allow open the same window as everywhere, scoped to those
 * routines. The agent that applies the skill reads nothing itself: its
 * skill's tools do, in the run of a routine.
 */
export function SkillSecrets({ skill }: { skill: string }) {
    const data = useAsync(() => api.skillNeeds(skill), [skill])
    const [dialog, setDialog] = useState<{ name: string; kind: EntryKind; editing?: VaultEntry } | null>(null)
    const needs = data.data?.needs ?? []
    const routines = data.data?.routines ?? []
    if (data.error) return <ErrorBox error={data.error} />
    if (!data.data) return null
    return (
        <div className='field wide skill-secrets'>
            <SectionHead
                title='Secrets and variables'
                hint={
                    needs.length
                        ? `What the scripts read; the runs of ${routines.length ? routines.join(', ') : 'no routine yet'} get what reaches them.`
                        : 'The scripts read nothing: a header line # secrets: NAME (or # vars:) names what they need.'
                }
            />
            {needs.length > 0 && (
                <div className='vault-list'>
                    {needs.map((n) => {
                        const missing = routines.filter((r) => !n.reaches.includes(r))
                        return (
                            <div
                                key={n.name}
                                className='vault-row'
                            >
                                <span className='vault-name'>
                                    <Icon
                                        name={n.kind === 'secret' ? 'secret' : 'variable'}
                                        size={14}
                                    />
                                    <strong className='mono'>{n.name}</strong>
                                    <span className='dim small mono'>{n.files.join(', ')}</span>
                                </span>
                                <span className='vault-uses'>
                                    {!n.entry ? (
                                        <span className='need missing'>{n.env ? 'only in .env' : 'not set'}</span>
                                    ) : routines.length === 0 ? (
                                        <span className='need ok'>
                                            <Icon
                                                name='ok'
                                                size={12}
                                            />
                                            {scopeText(n.entry.scope)}
                                        </span>
                                    ) : (
                                        routines.map((r) => (
                                            <span
                                                key={r}
                                                className={`need ${n.reaches.includes(r) ? 'ok' : 'missing'}`}
                                            >
                                                <Icon
                                                    name={n.reaches.includes(r) ? 'ok' : 'failed'}
                                                    size={12}
                                                />
                                                {r}
                                            </span>
                                        ))
                                    )}
                                </span>
                                <span className='vault-actions'>
                                    <Button
                                        size='sm'
                                        variant={!n.entry || missing.length ? 'primary' : undefined}
                                        onClick={() =>
                                            setDialog({
                                                name: n.name,
                                                kind: n.kind,
                                                editing: n.entry ? { ...n.entry, used_by: [] } : undefined
                                            })
                                        }
                                    >
                                        {!n.entry
                                            ? 'Set'
                                            : missing.length
                                              ? 'Allow'
                                              : n.kind === 'secret'
                                                ? 'Update'
                                                : 'Edit'}
                                    </Button>
                                </span>
                            </div>
                        )
                    })}
                </div>
            )}
            <SecretDialog
                open={dialog !== null}
                kind={dialog?.kind ?? 'secret'}
                editing={dialog?.editing}
                name={dialog?.name}
                routines={routines}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null)
                    data.reload()
                }}
            />
        </div>
    )
}

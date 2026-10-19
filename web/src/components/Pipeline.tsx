import { type ReactNode, useState } from 'react'

import {
    api,
    type EnvNeed,
    fmt,
    type FolderKind,
    type RoutineStepResult,
    type RoutineStepView,
    type RoutineView,
    type StepRun
} from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { CodeEditor } from './CodeEditor'
import { Field, str } from './Editor'
import { FileEditor, fileTemplate } from './Files'
import { Icon, type IconName } from './Icon'
import { Modal, useConfirm } from './Modal'
import { NeedsLine } from './Secrets'
import { Button, ErrorBox, SectionHead } from './ui'

/**
 * A step as the file has it: `{ run, … }`, `{ 'github-prs': {…} }`, `{ trac: {…} }`
 * or `{ agent, skill }`, each with an optional `name`. A bare string is a `run`.
 */
export type RawStep = Record<string, unknown>
export type StepKind = 'run' | 'github-prs' | 'trac' | 'agent'
export const kindOf = (s: RawStep): StepKind =>
    s.agent !== undefined
        ? 'agent'
        : s['github-prs'] !== undefined
          ? 'github-prs'
          : s.trac !== undefined
            ? 'trac'
            : 'run'

export const KIND_LABEL: Record<StepKind, string> = {
    run: 'Script',
    'github-prs': 'GitHub pull requests',
    trac: 'Trac tickets',
    agent: 'Agent'
}

/** Where a command's script lives: `"${ROUTINE_DIR}/scripts/x.sh" --days 7` → the routine's folder, `scripts/x.sh`. */
export function scriptRef(
    command: string,
    routine: string | null,
    skill: string | null
): { kind: FolderKind; name: string; path: string } | null {
    const m = /^\s*["']?\$\{?(ROUTINE_DIR|SKILL_DIR)\}?\/([^\s"']+)["']?/.exec(command)
    if (!m || m[2].split('/').includes('..')) return null
    if (m[1] === 'ROUTINE_DIR') return routine ? { kind: 'routines', name: routine, path: m[2] } : null
    return skill ? { kind: 'skills', name: skill, path: m[2] } : null
}

/** A script's file name from the step's name: "GSC stats" → `scripts/gsc-stats.sh`; other alphabets fall back to the step number. */
export function scriptName(name: string, index: number, taken: string[]): string {
    const slug =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || `step-${index + 1}`
    let file = `scripts/${slug}.sh`
    for (let n = 2; taken.includes(file); n++) file = `scripts/${slug}-${n}.sh`
    return file
}

/**
 * A Trac step keeps `url` (the site) and `query` apart in the file; the card shows them as the one
 * address of a custom query, the way the browser has it.
 */
function joinTracQuery(url: string, query: string): string {
    return url && query ? `${url}/query?${query}` : url || query
}

function splitTracQuery(text: string): { url: string | undefined; query: string } {
    const value = text.trim()
    const q = value.indexOf('?')
    const page = q < 0 ? value : value.slice(0, q)
    return {
        url: page.replace(/\/query\/?$/, '').replace(/\/+$/, '') || undefined,
        query: q < 0 ? '' : value.slice(q + 1)
    }
}

/**
 * The address of a Trac step as typed: the field keeps its own text (`https://` half typed, a
 * trailing `/query?`) and hands the parts over on every change; it reads the parts again only when
 * they change from outside.
 */
function TracAddress({
    url,
    query,
    onChange
}: {
    url: string
    query: string
    onChange: (parts: { url: string | undefined; query: string }) => void
}) {
    const joined = joinTracQuery(url, query)
    const [text, setText] = useState(joined)
    const [synced, setSynced] = useState(joined)
    if (joined !== synced) {
        setSynced(joined)
        const own = splitTracQuery(text)
        if (joinTracQuery(own.url ?? '', own.query) !== joined) setText(joined)
    }
    return (
        <input
            className='mono'
            value={text}
            onChange={(e) => {
                setText(e.target.value)
                onChange(splitTracQuery(e.target.value))
            }}
            placeholder='https://trac.example.com/query?status=new&component=Foo'
            title='The login is shared by every Trac step: TRAC_USER + TRAC_PASSWORD (or TRAC_COOKIE), in Settings → Secrets and variables'
        />
    )
}

/** `https://github.com/owner/name(.git)` or a page under it → `owner/name`; null for anything else. */
function repoSlug(text: string): string | null {
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(text.trim())
    return m ? `${m[1]}/${m[2]}` : null
}

/** `repo:` as the file has it: one repository, a list, or nothing (the project's). */
function repoList(value: unknown): string[] {
    return (Array.isArray(value) ? value : [value]).map(str).filter(Boolean)
}

/**
 * The repositories of a GitHub step, one per line: `owner/name` or the address from the browser,
 * read back as `owner/name` when the field is left. One stays a string in the file, several a list.
 */
function RepoList({ value, onChange }: { value: unknown; onChange: (repo: string | string[] | undefined) => void }) {
    const [text, setText] = useState(() => repoList(value).join('\n'))
    const put = (lines: string[]) => onChange(lines.length > 1 ? lines : lines[0])
    const lines = (t: string) =>
        t
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
    return (
        <textarea
            className='mono'
            rows={Math.min(8, Math.max(2, text.split('\n').length))}
            value={text}
            onChange={(e) => {
                setText(e.target.value)
                put(lines(e.target.value))
            }}
            onBlur={() => {
                const slugs = [...new Set(lines(text).map((l) => repoSlug(l) ?? l))]
                setText(slugs.join('\n'))
                put(slugs)
            }}
            placeholder={'owner/name\nhttps://github.com/owner/other'}
        />
    )
}

/** What the saved file says about a step, while the step still says what the file does. */
function factsOf(
    view: RoutineView | undefined,
    saved: RawStep[],
    i: number,
    step: RawStep
): RoutineStepView | undefined {
    const known = view?.steps[i]
    return known && known.kind === kindOf(step) && JSON.stringify(saved[i]) === JSON.stringify(step) ? known : undefined
}

/**
 * What a step needs from the environment, as the saved file says, kept while the step is edited
 * (the line of variables must not vanish at the first keystroke).
 */
function needsOf(view: RoutineView | undefined, i: number, step: RawStep): EnvNeed[] | undefined {
    const known = view?.steps[i]
    return known && known.kind === kindOf(step) ? known.needs : undefined
}

/**
 * The pipeline as a graph of cards, the way GitHub Actions draws a workflow's
 * jobs: each step a card with how it went last time (ok / failed and its time),
 * what it is for, and whether it misses a variable; arrows between them, the
 * agent last. A click opens the step in a window to edit it; Add step adds one
 * before the agent. Edits go into the form, which Save writes as usual.
 */
export function StepsField({
    model,
    steps,
    onChange,
    agents,
    skills,
    routine,
    view,
    saved,
    onChanged
}: {
    /** The model / provider picker of the agent step, when the routine may pin one. */
    model: ReactNode
    steps: RawStep[]
    onChange: (next: RawStep[]) => void
    agents: string[]
    skills: string[]
    /** The routine's name once it is saved (its folder exists to hold scripts). */
    routine: string | null
    /** The scheduler's view of the saved file: what each step's script says, what it reads, how it went. */
    view?: RoutineView
    /** The steps as the file on disk has them: a card shows the view's facts only while it says the same. */
    saved: RawStep[]
    /** A script or a secret changed: the cards refresh their facts. */
    onChanged: () => void
}) {
    const hasAgent = steps.some((s) => kindOf(s) === 'agent')
    const skill = str(steps.find((s) => kindOf(s) === 'agent')?.skill) || null
    // The step open in the window: its place, and whether it was just added (Cancel then takes it out again).
    const [editing, setEditing] = useState<{ index: number; fresh: boolean } | null>(null)
    const [adding, setAdding] = useState(false)
    // A new step goes before the agent, which stays last.
    const insertAt = hasAgent ? steps.length - 1 : steps.length
    const add = (step: RawStep) => {
        onChange([...steps.slice(0, insertAt), step, ...steps.slice(insertAt)])
        setAdding(false)
        setEditing({ index: insertAt, fresh: true })
    }
    const move = (i: number, dir: -1 | 1) => {
        const j = i + dir
        if (j < 0 || j >= steps.length || kindOf(steps[j]) === 'agent' || kindOf(steps[i]) === 'agent') return
        const next = [...steps]
        ;[next[i], next[j]] = [next[j], next[i]]
        onChange(next)
        setEditing((e) => (e ? { ...e, index: j } : e))
    }
    const lastSteps = view?.last_run?.steps ?? []
    const nodes = steps.map((step, i) => (
        <StepNode
            key={i}
            index={i}
            step={step}
            facts={factsOf(view, saved, i, step)}
            edited={JSON.stringify(saved[i]) !== JSON.stringify(step)}
            last={lastSteps.find((r) => r.index === i && r.name === (view?.steps[i]?.name ?? str(step.name)))}
            onOpen={() => setEditing({ index: i, fresh: false })}
        />
    ))
    const addNode = (
        <button
            key='add'
            type='button'
            className='step-node add'
            onClick={() => setAdding(true)}
            title='Add a step before the agent'
        >
            <span className='step-node-plus'>
                <Icon
                    name='add'
                    size={14}
                />
            </span>
            <span>Add step</span>
        </button>
    )
    const flow = [...nodes.slice(0, insertAt), addNode, ...nodes.slice(insertAt)]
    const open = editing && steps[editing.index] ? editing : null
    return (
        <div className='field wide triggers'>
            <SectionHead
                title='Pipeline'
                hint={
                    <span title='A failing step stops the run; when every source is empty, the agent does not run.'>
                        Runs top to bottom; click a step to edit it.
                    </span>
                }
            />
            <div
                className='pipeline-graph'
                role='list'
            >
                {flow.map((node, i) => (
                    <div
                        key={i}
                        className='pipeline-cell'
                        role='listitem'
                    >
                        {i > 0 && (
                            <span
                                className='pipeline-edge'
                                aria-hidden
                            />
                        )}
                        {node}
                    </div>
                ))}
            </div>
            {open && (
                <StepWindow
                    key={open.index}
                    index={open.index}
                    step={steps[open.index]}
                    fresh={open.fresh}
                    facts={(draft) => factsOf(view, saved, open.index, draft)}
                    needs={(draft) => needsOf(view, open.index, draft)}
                    lastRun={view?.last_run}
                    agents={agents}
                    skills={skills}
                    model={model}
                    routine={routine}
                    skill={skill}
                    canMoveUp={open.index > 0 && kindOf(steps[open.index]) !== 'agent'}
                    canMoveDown={
                        open.index < steps.length - 1 &&
                        kindOf(steps[open.index]) !== 'agent' &&
                        kindOf(steps[open.index + 1]) !== 'agent'
                    }
                    onApply={(next) => {
                        onChange(steps.map((x, j) => (j === open.index ? next : x)))
                        setEditing(null)
                    }}
                    onCancel={() => {
                        if (open.fresh) onChange(steps.filter((_, j) => j !== open.index))
                        setEditing(null)
                    }}
                    onRemove={() => {
                        onChange(steps.filter((_, j) => j !== open.index))
                        setEditing(null)
                    }}
                    onMove={(dir) => move(open.index, dir)}
                    onChanged={onChanged}
                />
            )}
            <AddStepWindow
                open={adding}
                routine={routine}
                hasAgent={hasAgent}
                insertAt={insertAt}
                onAdd={(step) => {
                    if (step.agent !== undefined) {
                        onChange([...steps, step])
                        setAdding(false)
                        setEditing({ index: steps.length, fresh: true })
                    } else add(step)
                }}
                onClose={() => setAdding(false)}
                onChanged={onChanged}
            />
        </div>
    )
}

const KIND_ICON: Record<StepKind, IconName> = { run: 'script', 'github-prs': 'pr', trac: 'ticket', agent: 'agents' }

/** A step's card in the graph: its state, kind, name, what it is for and what it misses. */
function StepNode({
    index,
    step,
    facts,
    edited,
    last,
    onOpen
}: {
    index: number
    step: RawStep
    facts?: RoutineStepView
    edited: boolean
    last?: RoutineStepResult
    onOpen: () => void
}) {
    const kind = kindOf(step)
    const options = (kind === 'github-prs' || kind === 'trac' ? step[kind] : {}) as RawStep
    const name =
        kind === 'agent'
            ? str(step.agent) && str(step.agent) !== 'orchestrator'
                ? str(step.agent)
                : 'orchestrator'
            : str(step.name) || facts?.name || `step ${index + 1}`
    const about =
        kind === 'run'
            ? facts?.script?.description || str(step.run) || 'no command yet'
            : kind === 'trac'
              ? joinTracQuery(str(options.url), str(options.query)) || 'no query yet'
              : kind === 'github-prs'
                ? `${repoList(options.repo).join(', ') || "the project's repository"} · ${str(options.filter) || 'open'}`
                : str(step.skill)
                  ? `skill ${str(step.skill)}`
                  : 'reads the instructions and what the steps found'
    const missing = (facts?.needs ?? []).filter((n) => n.from === null && !n.optional)
    const state = edited ? 'edited' : last ? (last.ok ? 'ok' : 'failed') : 'idle'
    return (
        <button
            type='button'
            className={`step-node ${kind} ${state}`}
            onClick={onOpen}
            title={`${KIND_LABEL[kind]}: ${name}${about ? `\n${about}` : ''}`}
        >
            <span className='step-node-head'>
                <span
                    className={`step-node-state ${state}`}
                    aria-label={state}
                >
                    {state === 'ok' ? (
                        <Icon
                            name='ok'
                            size={12}
                        />
                    ) : state === 'failed' ? (
                        <Icon
                            name='failed'
                            size={12}
                        />
                    ) : state === 'edited' ? (
                        <span className='step-node-dot' />
                    ) : null}
                </span>
                <span className='step-node-name'>{name}</span>
                <span className='step-node-kind'>
                    <Icon
                        name={KIND_ICON[kind]}
                        size={12}
                    />
                    {kind === 'run' ? 'Script' : KIND_LABEL[kind]}
                </span>
                <span className='grow' />
                {edited ? (
                    <span className='step-node-time'>unsaved</span>
                ) : (
                    last && (
                        <span className='step-node-time'>
                            {fmt.duration(last.ms)}
                            {last.items !== undefined ? ` · ${last.items}` : ''}
                        </span>
                    )
                )}
            </span>
            <span className='step-node-about'>{about}</span>
            {(missing.length > 0 || (facts?.needs.length ?? 0) > 0) && (
                <span className={`step-node-needs ${missing.length ? 'missing' : 'ok'}`}>
                    <Icon
                        name={missing.length ? 'alert' : 'secret'}
                        size={12}
                    />
                    {missing.length
                        ? `${missing.map((n) => n.name).join(', ')} not set`
                        : `${facts!.needs.length} variable${facts!.needs.length === 1 ? '' : 's'} set`}
                </span>
            )}
        </button>
    )
}

/**
 * One step in a window: its card's fields on a draft, so Cancel leaves the
 * pipeline as it was; a script step opens its script in the editor at once
 * (saved to the file on its own). Apply puts the draft into the form.
 */
function StepWindow({
    index,
    step,
    fresh,
    facts,
    needs,
    lastRun,
    agents,
    skills,
    model,
    routine,
    skill,
    canMoveUp,
    canMoveDown,
    onApply,
    onCancel,
    onRemove,
    onMove,
    onChanged
}: {
    index: number
    step: RawStep
    fresh: boolean
    facts: (draft: RawStep) => RoutineStepView | undefined
    needs: (draft: RawStep) => EnvNeed[] | undefined
    lastRun?: RoutineView['last_run']
    agents: string[]
    skills: string[]
    model: ReactNode
    routine: string | null
    skill: string | null
    canMoveUp: boolean
    canMoveDown: boolean
    onApply: (next: RawStep) => void
    onCancel: () => void
    onRemove: () => void
    onMove: (dir: -1 | 1) => void
    onChanged: () => void
}) {
    const [draft, setDraft] = useState(step)
    const kind = kindOf(draft)
    const changed = JSON.stringify(draft) !== JSON.stringify(step)
    // Unsaved edits in the script's editor: the file is saved on its own, so closing the window would lose them.
    const [scriptDirty, setScriptDirty] = useState(false)
    const confirm = useConfirm()
    const cancel = () => {
        if (!changed && !scriptDirty) return onCancel()
        void confirm({
            title: changed
                ? scriptDirty
                    ? 'Drop the changes to this step and its script?'
                    : 'Drop the changes to this step?'
                : 'Drop the unsaved edits to the script?',
            message: scriptDirty
                ? `${changed ? 'The step stays as it was; the' : 'The'} script's unsaved edits are lost (Save file keeps them).`
                : 'The step stays as it was; edits to its script file are saved already.',
            action: 'Drop',
            danger: true,
            icon: 'warning',
            onConfirm: onCancel
        })
    }
    const apply = () => {
        if (!scriptDirty) return onApply(draft)
        void confirm({
            title: 'Drop the unsaved edits to the script?',
            message: 'The step is applied; the script file stays as it was last saved (Save file keeps the edits).',
            action: 'Drop',
            danger: true,
            icon: 'warning',
            onConfirm: () => onApply(draft)
        })
    }
    const name = str(draft.name) || (kind === 'agent' ? 'Agent' : `step ${index + 1}`)
    return (
        <Modal
            open
            onClose={cancel}
            icon='routines'
            size={kind === 'run' ? 'large' : 'wide'}
            title={`${index + 1}. ${kind === 'agent' ? 'Agent' : name}`}
            description={`${KIND_LABEL[kind]}${fresh ? ' · new step' : ''}${changed ? ' · changed' : ''}`}
            content={
                <StepCard
                    index={index}
                    step={draft}
                    agents={agents}
                    skills={skills}
                    model={model}
                    routine={routine}
                    skill={skill}
                    facts={facts(draft)}
                    needs={needs(draft)}
                    lastRun={lastRun}
                    onChange={setDraft}
                    onChanged={onChanged}
                    onScriptDirty={setScriptDirty}
                />
            }
            footer={
                <>
                    <span className='modal-foot-aside'>
                        {kind !== 'agent' && (
                            <>
                                <Button
                                    size='sm'
                                    variant='ghost'
                                    onClick={() => onMove(-1)}
                                    disabled={!canMoveUp || changed}
                                    title={changed ? 'Apply or drop the changes first' : 'Run it one step earlier'}
                                >
                                    ← Earlier
                                </Button>
                                <Button
                                    size='sm'
                                    variant='ghost'
                                    onClick={() => onMove(1)}
                                    disabled={!canMoveDown || changed}
                                    title={changed ? 'Apply or drop the changes first' : 'Run it one step later'}
                                >
                                    Later →
                                </Button>
                            </>
                        )}
                        <Button
                            size='sm'
                            variant='ghost'
                            onClick={onRemove}
                        >
                            Remove step
                        </Button>
                    </span>
                    <Button onClick={cancel}>Cancel</Button>
                    <Button
                        variant='primary'
                        onClick={apply}
                    >
                        {changed || fresh ? 'Apply' : 'Done'}
                    </Button>
                </>
            }
        />
    )
}

/** What a new step is: a script in the routine's folder (named first), a command, a source, or the agent. */
function AddStepWindow({
    open,
    routine,
    hasAgent,
    insertAt,
    onAdd,
    onClose,
    onChanged
}: {
    open: boolean
    routine: string | null
    hasAgent: boolean
    insertAt: number
    onAdd: (step: RawStep) => void
    onClose: () => void
    onChanged: () => void
}) {
    const [name, setName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const close = () => {
        setName('')
        setError(null)
        onClose()
    }
    // A saved routine gets a real file for a new script step, with a header that says what it is.
    const addScript = async () => {
        const title = name.trim()
        if (!routine || !title) return
        setBusy(true)
        setError(null)
        try {
            const taken = (await api.folderFiles('routines', routine)).map((f) => f.path)
            const file = scriptName(title, insertAt, taken)
            await api.saveFolderFile('routines', routine, file, { text: fileTemplate(file, title) })
            onChanged()
            setName('')
            onAdd({ name: title, run: `"\${ROUTINE_DIR}/${file}"` })
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const choice = (label: string, about: string, step: RawStep, disabled = false) => (
        <button
            type='button'
            className='step-choice'
            disabled={disabled}
            onClick={() => {
                setName('')
                onAdd(step)
            }}
        >
            <strong>{label}</strong>
            <span className='dim small'>{about}</span>
        </button>
    )
    return (
        <Modal
            open={open}
            onClose={close}
            size='wide'
            icon='routines'
            busy={busy}
            title='Add a step'
            description='It goes before the agent; open it afterwards to fill it in.'
            footer={<Button onClick={close}>Cancel</Button>}
        >
            <div className='step-choices'>
                <form
                    className='step-choice script'
                    onSubmit={(e) => {
                        e.preventDefault()
                        void addScript()
                    }}
                >
                    <strong>Script</strong>
                    <span className='dim small'>
                        {routine
                            ? "A new file in the routine's folder, scripts/<name>.sh, with a header saying what it does."
                            : 'Save the routine first: its scripts live in its folder.'}
                    </span>
                    <span
                        className='row'
                        style={{ gap: 8 }}
                    >
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder='What it does: Search Console stats'
                            aria-label='New script step name'
                            disabled={!routine}
                        />
                        <Button
                            variant='primary'
                            type='submit'
                            disabled={!routine || !name.trim() || busy}
                        >
                            Create
                        </Button>
                    </span>
                </form>
                {choice('Command', 'One line of bash, no file: a quick check, a curl.', { run: '' })}
                {choice('GitHub pull requests', 'Open PRs of a repository; nothing new means no agent.', {
                    'github-prs': { filter: 'open' }
                })}
                {choice('Trac tickets', 'The tickets of a Trac query; nothing new means no agent.', {
                    trac: { url: '' }
                })}
                {!hasAgent &&
                    choice('Agent', 'The last step: reads the instructions and what the steps found.', {
                        agent: 'orchestrator'
                    })}
            </div>
            <ErrorBox error={error} />
        </Modal>
    )
}

/** One step of the pipeline. The kind is what the file keys say; its options are the card's fields. */
function StepCard({
    index,
    step,
    agents,
    skills,
    model,
    routine,
    skill,
    facts,
    needs: envNeeds,
    lastRun,
    onChange,
    onChanged,
    onScriptDirty
}: {
    index: number
    step: RawStep
    agents: string[]
    skills: string[]
    model: ReactNode
    routine: string | null
    skill: string | null
    /** What the saved file says about this step, when the card has not changed since. */
    facts?: RoutineStepView
    /** What it needs from the environment: the saved file's view, kept while the card is edited. */
    needs?: EnvNeed[]
    lastRun?: RoutineView['last_run']
    onChange: (next: RawStep) => void
    onChanged: () => void
    /** Whether the script's editor holds unsaved edits (the window asks before closing). */
    onScriptDirty?: (dirty: boolean) => void
}) {
    const kind = kindOf(step)
    const options = (kind === 'github-prs' || kind === 'trac' ? step[kind] : {}) as RawStep
    const setOptions = (patch: RawStep) => onChange({ ...step, [kind]: { ...options, ...patch } })
    const [run, setRun] = useState<StepRun | null>(null)
    const [running, setRunning] = useState(false)
    const [runError, setRunError] = useState<string | null>(null)
    const last = lastRun?.steps?.find((s) => s.index === index && s.name === (facts?.name ?? str(step.name)))
    // The card's draft is what runs: a step is tried while it is edited, before Save.
    const runnable = Boolean(routine && kind !== 'agent')
    const runStep = async () => {
        if (!routine) return
        setRunning(true)
        setRunError(null)
        try {
            setRun(await api.runRoutineStep(routine, index, step))
        } catch (e) {
            setRunError((e as Error).message)
        } finally {
            setRunning(false)
        }
    }
    const head = (
        <div
            className='row wide'
            style={{ gap: 8 }}
        >
            {last ? (
                <span
                    className={`badge ${last.ok ? 'done' : 'failed'}`}
                    title={`last run ${lastRun ? fmt.ago(lastRun.fired_at) : ''}: ${last.ok ? 'ok' : 'failed'} in ${fmt.duration(last.ms)}${last.items !== undefined ? `, ${last.items} item(s)` : ''}`}
                >
                    last run{' '}
                    <Icon
                        name={last.ok ? 'ok' : 'failed'}
                        size={12}
                    />{' '}
                    {fmt.duration(last.ms)}
                </span>
            ) : (
                <span className='dim small'>{facts ? 'not run yet' : 'changed: Run step tries it as it stands'}</span>
            )}
            <span className='grow' />
            {kind !== 'agent' && (
                <Button
                    size='sm'
                    onClick={() => void runStep()}
                    disabled={!runnable || running}
                    title={
                        runnable
                            ? 'Run this step alone, as it stands here, as a run would; nothing is recorded, the agent does not start'
                            : 'Save the routine first: its folder holds the scripts'
                    }
                >
                    {running ? 'Running…' : '▶ Run step'}
                </Button>
            )}
        </div>
    )
    const output = (run || runError) && (
        <StepOutput
            run={run}
            error={runError}
            onClose={() => {
                setRun(null)
                setRunError(null)
            }}
        />
    )
    const needs = envNeeds && routine && (
        <NeedsLine
            needs={envNeeds}
            routine={routine}
            onChanged={onChanged}
        />
    )
    if (kind === 'agent')
        return (
            <div className='trigger-card step-card'>
                {head}
                {needs}
                <Field
                    label='Agent'
                    hint='Runs as it: its prompt, tools and model.'
                >
                    <select
                        value={str(step.agent) || 'orchestrator'}
                        onChange={(e) => onChange({ ...step, agent: e.target.value })}
                    >
                        <option value='orchestrator'>— the orchestrator decides —</option>
                        {agents.map((a) => (
                            <option
                                key={a}
                                value={a}
                            >
                                {a}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field
                    label='Skill'
                    hint='In the prompt; its folder is SKILL_DIR.'
                >
                    <select
                        value={str(step.skill)}
                        onChange={(e) => onChange({ ...step, skill: e.target.value || undefined })}
                    >
                        <option value=''>— none —</option>
                        {skills.map((s) => (
                            <option
                                key={s}
                                value={s}
                            >
                                {s}
                            </option>
                        ))}
                    </select>
                </Field>
                {model}
            </div>
        )
    if (kind === 'run') {
        const ref = scriptRef(str(step.run), routine, skill)
        const script = facts?.script
        const runFields = (
            <>
                <Field
                    label='Command (bash)'
                    hint='Runs in the checkout; ${ROUTINE_DIR} is this routine’s folder.'
                    wide
                >
                    <div
                        className='step-command'
                        title="Environment: the agent's, the secrets and variables this routine may read, plus ROUTINE, ROUTINE_DIR, ROUTINE_FILE, PROJECT, PROJECT_DIR, SKILL_DIR"
                    >
                        <CodeEditor
                            value={str(step.run)}
                            onChange={(run) => onChange({ ...step, run })}
                            path='command.sh'
                            label='Command (bash)'
                            placeholder={'"${ROUTINE_DIR}/scripts/stats.sh" --days 7'}
                            rows={ref ? 2 : 3}
                        />
                    </div>
                </Field>
                <Field
                    label='Name'
                    hint='Labels its output for the agent.'
                >
                    <input
                        value={str(step.name)}
                        onChange={(e) => onChange({ ...step, name: e.target.value || undefined })}
                        placeholder={`step ${index + 1}`}
                    />
                </Field>
                <Field
                    label='Timeout (seconds)'
                    hint='Then the step is stopped.'
                >
                    <input
                        type='number'
                        min={5}
                        max={3600}
                        value={str(step.timeout_s) || '300'}
                        onChange={(e) => onChange({ ...step, timeout_s: Number(e.target.value) || undefined })}
                    />
                </Field>
                <Field
                    label='Working directory'
                    hint='Relative to the checkout.'
                >
                    <input
                        className='mono'
                        value={str(step.cwd)}
                        onChange={(e) => onChange({ ...step, cwd: e.target.value || undefined })}
                    />
                </Field>
                <Field
                    label='Output'
                    group
                    wide
                >
                    <div className='row wrap step-checks'>
                        <Check
                            checked={step.items === true}
                            onChange={(on) => onChange({ ...step, items: on ? true : undefined, new_only: undefined })}
                            label='Prints a list of items'
                            title='key⇥title per line, or JSON; an empty list means no agent'
                        />
                        {step.items === true && (
                            <Check
                                checked={step.new_only !== false}
                                onChange={(on) => onChange({ ...step, new_only: on ? undefined : false })}
                                label='New items only'
                            />
                        )}
                    </div>
                </Field>
            </>
        )
        return (
            <div className='trigger-card step-card'>
                {head}
                <div className='wide step-about'>
                    {ref ? (
                        <>
                            {script?.description ? (
                                <div className='step-description'>{script.description}</div>
                            ) : (
                                <div className='dim small'>
                                    {script && !script.exists
                                        ? 'The file does not exist yet.'
                                        : 'No description: the comment under the shebang becomes one.'}
                                </div>
                            )}
                            <span className='badge plain mono step-file'>
                                {ref.kind === 'skills' ? `skill ${ref.name} · ` : ''}
                                {ref.path}
                            </span>
                        </>
                    ) : (
                        <div className='dim small'>
                            An inline command.{' '}
                            {routine
                                ? `A script in the routine's folder is easier to read and edit: Add step → Script, or "\${ROUTINE_DIR}/scripts/<name>.sh".`
                                : ''}
                        </div>
                    )}
                </div>
                {needs}
                {output}
                {ref && (
                    <ScriptEditor
                        target={ref}
                        description={str(step.name) || KIND_LABEL.run}
                        onSaved={onChanged}
                        onDirty={onScriptDirty}
                    />
                )}
                {ref ? (
                    <details className='field wide more'>
                        <summary>
                            More
                            <span className='dim'>
                                {' '}
                                · the command, timeout, folder, output
                                <span className='mono'> · {str(step.run)}</span>
                            </span>
                        </summary>
                        <div className='form-grid'>{runFields}</div>
                    </details>
                ) : (
                    runFields
                )}
            </div>
        )
    }
    if (kind === 'github-prs')
        return (
            <div className='trigger-card step-card'>
                {head}
                <Field
                    label='Repositories'
                    hint="One per line, owner/name or its GitHub address; empty = the project's."
                    wide
                >
                    <RepoList
                        value={options.repo}
                        onChange={(repo) => setOptions({ repo })}
                    />
                </Field>
                <Field
                    label='Which pull requests'
                    hint='A new push brings a PR up again.'
                >
                    <select
                        value={str(options.filter) || 'open'}
                        onChange={(e) => setOptions({ filter: e.target.value })}
                    >
                        <option value='open'>every open PR</option>
                        <option value='review-requested'>where my review is requested</option>
                        <option value='mentioned'>where I am mentioned</option>
                    </select>
                </Field>
                <Field
                    label='Also'
                    group
                    wide
                >
                    <div className='row wrap step-checks'>
                        <Check
                            checked={options.mine === true}
                            onChange={(on) => setOptions({ mine: on || undefined })}
                            label='My own pull requests'
                        />
                        <Check
                            checked={options.drafts === true}
                            onChange={(on) => setOptions({ drafts: on || undefined })}
                            label='Drafts'
                        />
                        <Check
                            checked={options.new_only !== false}
                            onChange={(on) => setOptions({ new_only: on ? undefined : false })}
                            label='New items only'
                        />
                    </div>
                </Field>
                {output}
            </div>
        )
    return (
        <div className='trigger-card step-card'>
            {head}
            {needs}
            <Field
                label='Query'
                hint='Custom query URL from the browser'
            >
                <TracAddress
                    url={str(options.url)}
                    query={str(options.query)}
                    onChange={setOptions}
                />
            </Field>
            <Field
                label='Also'
                group
                wide
            >
                <div className='row wrap step-checks'>
                    <Check
                        checked={options.on_change !== false}
                        onChange={(on) => setOptions({ on_change: on ? undefined : false })}
                        label='A changed ticket is new again'
                    />
                    <Check
                        checked={options.new_only !== false}
                        onChange={(on) => setOptions({ new_only: on ? undefined : false })}
                        label='New items only'
                    />
                </div>
            </Field>
            {output}
        </div>
    )
}

/** The script of a step, open in the card: the folder's file in the code editor, or Create when it is not there. */
function ScriptEditor({
    target,
    description,
    onSaved,
    onDirty
}: {
    target: { kind: FolderKind; name: string; path: string }
    description: string
    onSaved: () => void
    onDirty?: (dirty: boolean) => void
}) {
    const files = useAsync(() => api.folderFiles(target.kind, target.name), [target.kind, target.name])
    const [error, setError] = useState<string | null>(null)
    const file = files.data?.find((f) => f.path === target.path)
    const create = async () => {
        setError(null)
        try {
            await api.saveFolderFile(target.kind, target.name, target.path, {
                text: fileTemplate(target.path, description)
            })
            files.reload()
            onSaved()
        } catch (e) {
            setError((e as Error).message)
        }
    }
    return (
        <div className='wide step-script'>
            <ErrorBox error={files.error ?? error} />
            {file ? (
                <FileEditor
                    key={file.path}
                    kind={target.kind}
                    name={target.name}
                    file={file}
                    compact
                    onDirty={onDirty}
                    onSaved={() => {
                        files.reload()
                        onSaved()
                    }}
                />
            ) : files.data ? (
                <div
                    className='row'
                    style={{ gap: 8 }}
                >
                    <span className='dim small'>
                        <span className='mono'>{target.path}</span> is not in the folder yet.
                    </span>
                    <Button
                        size='sm'
                        variant='primary'
                        onClick={() => void create()}
                    >
                        Create it
                    </Button>
                </div>
            ) : (
                <div className='dim small'>Loading…</div>
            )}
        </div>
    )
}

/** What "Run step" brought back: the exit code and time, the output, a source's items. */
function StepOutput({ run, error, onClose }: { run: StepRun | null; error: string | null; onClose: () => void }) {
    return (
        <div className='wide step-output'>
            <div className='row between'>
                <span className='small'>
                    {run ? (
                        <>
                            <span className={`badge ${run.ok ? 'done' : 'failed'}`}>
                                {run.ok
                                    ? 'ok'
                                    : run.timed_out
                                      ? 'timed out'
                                      : run.code !== null
                                        ? `exit ${run.code}`
                                        : 'failed'}
                            </span>{' '}
                            <span className='dim'>
                                {fmt.duration(run.ms)}
                                {run.items ? ` · ${run.items.length} item(s)` : ''} · nothing recorded
                            </span>
                        </>
                    ) : (
                        <span className='error'>{error}</span>
                    )}
                </span>
                <Button
                    size='sm'
                    variant='ghost'
                    onClick={onClose}
                >
                    Close
                </Button>
            </div>
            <ErrorBox
                error={run?.error}
                inline
            />
            {run?.stdout && <pre className='mono small'>{run.stdout}</pre>}
            {run?.stderr && (
                <>
                    <div className='dim small'>stderr</div>
                    <pre className='mono small step-stderr'>{run.stderr}</pre>
                </>
            )}
            {run?.items && run.items.length > 0 && (
                <ul className='step-items small'>
                    {run.items.slice(0, 50).map((item) => (
                        <li key={item.key}>
                            {item.url ? (
                                <a
                                    href={item.url}
                                    target='_blank'
                                    rel='noreferrer'
                                >
                                    {item.title}
                                </a>
                            ) : (
                                item.title
                            )}
                            {item.text && <span className='dim'> · {item.text}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {run && !run.stdout && !run.stderr && !run.items?.length && !run.error && (
                <div className='dim small'>(no output)</div>
            )}
        </div>
    )
}

export function Check({
    checked,
    onChange,
    label,
    title
}: {
    checked: boolean
    onChange: (on: boolean) => void
    label: string
    title?: string
}) {
    return (
        <label
            className='row'
            title={title}
            style={{ gap: 8 }}
        >
            <input
                type='checkbox'
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
            />{' '}
            <span>{label}</span>
        </label>
    )
}

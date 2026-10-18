import { createHash } from 'node:crypto'

import type { Preview, RoutineView } from '../routines/service.js'
import type { Item } from '../routines/sources.js'
import type { RoutineRun } from '../store/index.js'
import { type Button, escapeHtml, row, text, type View } from './view.js'

/**
 * The routines on buttons: `/routines` lists them, each with its own buttons
 * under its line (run, on / off, details); a routine's card shows its state,
 * agent, triggers, last and next run, and acts on it (run, switch, preview
 * what a poll would hand over, the last runs). One message, edited in place.
 * Callback data is `r|<action>|<key>` (64 bytes at most), so a long name
 * travels as a hash of itself.
 */

/** `list`, `card`, `run`, `all`, `on`, `off`, `preview` and `runs` edit the menu message; `open` and `fire` sit under a report or a notice and send a new one. */
export type RoutineAction = 'list' | 'card' | 'run' | 'all' | 'on' | 'off' | 'preview' | 'runs' | 'open' | 'fire'

const DATA_MAX = 64
const hashed = (name: string) => createHash('sha1').update(name).digest('hex').slice(0, 12)

/** The key a routine's buttons carry: the name itself when it fits, its hash otherwise. */
export function routineKey(name: string): string {
    return Buffer.byteLength(`r|preview|${name}|l`) <= DATA_MAX ? name : hashed(name)
}

/** `from: 'list'` marks a button of the list, so the tap redraws the list, not the routine's card. */
export const routineData = (action: RoutineAction, name?: string, from?: 'list'): string =>
    name === undefined ? `r|${action}` : `r|${action}|${routineKey(name)}${from ? `|${from[0]}` : ''}`

/** The routine a button's key names. */
export function findRoutine(list: RoutineView[], key: string): RoutineView | undefined {
    return list.find((r) => r.name === key) ?? list.find((r) => hashed(r.name) === key)
}

export function parseRoutineData(
    data: string
): { action: RoutineAction; key: string | null; from: 'list' | null } | null {
    const [kind, action, key, from] = data.split('|')
    if (kind !== 'r' || !action) return null
    return { action: action as RoutineAction, key: key ?? null, from: from === 'l' ? 'list' : null }
}

/** Time to or since `iso`: `5 min`, `3 h`, `2 d`. */
function span(iso: string, now: number): string {
    const ms = Math.abs(new Date(iso).getTime() - now)
    if (ms < 60_000) return 'under a minute'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h`
    return `${Math.floor(ms / 86_400_000)} d`
}

/** `Tue 17:00` in the owner's zone. */
const clockAt = (iso: string, timeZone: string) =>
    new Date(iso).toLocaleString('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' })

export const routineState = (r: RoutineView): string =>
    r.errors.length ? '⚠️' : r.active_task ? '🔵' : r.enabled ? '🟢' : '⚪️'

const stateWord = (r: RoutineView): string =>
    r.errors.length
        ? 'invalid'
        : r.active_task
          ? r.active_task.status === 'running'
              ? 'running now'
              : 'queued'
          : r.enabled
            ? 'on'
            : 'off'

const RUN_ICON: Record<RoutineRun['status'], string> = {
    queued: '▶️',
    done: '✅',
    empty: '·',
    skipped: '⏸',
    error: '⚠️',
    missed: '⏭'
}

/** One run as a line: when, how it fired, what came of it. */
function runLine(run: RoutineRun, timeZone: string, now: number): string {
    const outcome =
        run.status === 'queued'
            ? (run.task_status ?? 'queued')
            : run.status === 'empty'
              ? 'nothing new'
              : `${run.status}${run.note ? ` — ${run.note}` : ''}`
    const by = run.trigger === 'manual' ? ' (by hand)' : run.items ? ` (${run.items} new)` : ''
    return `${RUN_ICON[run.status]} ${clockAt(run.fired_at, timeZone)} · ${span(run.fired_at, now)} ago${by}: ${escapeHtml(outcome)}`
}

const whenText = (r: RoutineView) => r.triggers.map((t) => t.cron_text).join('; ') || 'by hand only'

/** The last run and the next firing in a few words. */
function lastAndNext(r: RoutineView, now: number): string {
    const last = r.last_run
        ? `last ${r.last_run.status === 'queued' ? (r.last_run.task_status ?? 'queued') : r.last_run.status} ${span(r.last_run.fired_at, now)} ago`
        : 'never ran'
    const next = r.next_run ? `next in ${span(r.next_run, now)}` : null
    return [last, next].filter(Boolean).join(' · ')
}

/** The buttons that act on a routine: run (or stop its run), switch, details; in the classic form each names the routine. */
const actButtons = (r: RoutineView): Button[] => [
    r.active_task
        ? { text: '⏹ Stop', plain: `⏹ ${r.name}`, data: `s|stop|${r.active_task.id}|l`, style: 'danger' }
        : r.errors.length
          ? { text: '▶️ Run', plain: `▶️ ${r.name}`, disabled: true }
          : { text: '▶️ Run', plain: `▶️ ${r.name}`, data: routineData('run', r.name, 'list'), style: 'success' },
    r.errors.length
        ? { text: '⚠️ Invalid', disabled: true }
        : { text: r.enabled ? '⏸ Off' : '▶ On', data: routineData(r.enabled ? 'off' : 'on', r.name, 'list') },
    { text: '📋 Details', data: routineData('card', r.name), style: 'primary' }
]

/** `/routines`: every routine on a line with its own buttons under it; `note` is what the last tap came to. */
export function routinesList(
    list: RoutineView[],
    webUrl: string | null = null,
    now = Date.now(),
    note: string | null = null
): View {
    if (!list.length)
        return [
            text('No routines yet — create one in the web UI (Routines).'),
            row(
                { text: '🔄 Refresh', data: routineData('list') },
                webUrl ? { text: '🌐 Routines in the web', url: `${webUrl}/routines` } : null
            )
        ]
    const on = list.filter((r) => r.enabled && !r.errors.length).length
    const view: View = [text(`<b>Routines</b> · ${list.length}, ${on} on`)]
    for (const r of list) {
        const who = [r.agent, r.project].filter(Boolean).join(' · ')
        view.push(
            text(
                `${routineState(r)} <b>${escapeHtml(r.name)}</b>${who ? ` — ${escapeHtml(who)}` : ''}\n<i>${escapeHtml(whenText(r))} · ${lastAndNext(r, now)}</i>`
            ),
            row(...actButtons(r))
        )
    }
    if (note) view.push(text(escapeHtml(note)))
    view.push(
        row(
            { text: '🔄 Refresh', data: routineData('list') },
            webUrl ? { text: '🌐 Web', url: `${webUrl}/routines` } : null
        )
    )
    return view
}

/** A routine's card: what it is, how it stands, and the buttons that act on it. */
export function routineCard(
    r: RoutineView,
    timeZone: string,
    options: { note?: string; webUrl?: string | null; now?: number; emptyRun?: number } = {}
): View {
    const now = options.now ?? Date.now()
    const lines = [`${routineState(r)} <b>${escapeHtml(r.name)}</b> · ${stateWord(r)}`]
    if (r.errors.length) lines.push(`⚠️ ${escapeHtml(r.errors.join('; '))}`)
    for (const w of r.warnings) lines.push(`⚠️ ${escapeHtml(w)}`)
    const facts = [
        r.has_agent ? (r.agent ? `agent: ${r.agent}` : 'agent: the orchestrator') : 'scripts only, no agent',
        r.skill ? `skill: ${r.skill}` : null,
        r.project ? `project: ${r.project}` : null,
        r.provider ? `on ${r.provider}${r.model ? ` · ${r.model}` : ''}` : r.model ? `model: ${r.model}` : null,
        `pipeline: ${r.steps.map((s) => s.name).join(' → ')}`
    ].filter(Boolean)
    if (facts.length) lines.push(escapeHtml(facts.join(' · ')))
    lines.push(`triggers: ${escapeHtml(whenText(r))}${r.once ? ' · once' : ''}`)
    if (r.last_run) lines.push(runLine(r.last_run, timeZone, now).replace(/^(\S+) /, '$1 last run '))
    else lines.push('never ran')
    if (r.next_run) lines.push(`next: ${clockAt(r.next_run, timeZone)} (in ${span(r.next_run, now)})`)
    const view: View = [text(lines.join('\n'))]
    if (options.note) view.push(text(escapeHtml(options.note)))

    const first: Button[] = []
    if (r.active_task) first.push({ text: '⏹ Stop the run', data: `s|stop|${r.active_task.id}|c`, style: 'danger' })
    else if (!r.errors.length) first.push({ text: '▶️ Run now', data: routineData('run', r.name), style: 'success' })
    // A manual run that found nothing new: the owner may still want the agent to look at everything.
    if (options.emptyRun && !r.active_task && !r.errors.length)
        first.push({ text: `▶️ Run with all ${options.emptyRun}`, data: routineData('all', r.name) })
    if (!r.errors.length)
        first.push({
            text: r.enabled ? '⏸ Switch off' : '▶ Switch on',
            data: routineData(r.enabled ? 'off' : 'on', r.name)
        })
    view.push(row(...first))
    view.push(
        row(
            r.steps.some((s) => s.kind !== 'agent')
                ? { text: '👁 Preview', data: routineData('preview', r.name) }
                : null,
            { text: '📜 Runs', data: routineData('runs', r.name) },
            options.webUrl
                ? { text: '🌐 Open', url: `${options.webUrl}/routines/${encodeURIComponent(r.name)}` }
                : null,
            { text: '« Routines', data: routineData('list') }
        )
    )
    return view
}

/** The last runs of a routine, newest first. */
export function runsText(r: RoutineView, runs: RoutineRun[], timeZone: string, now = Date.now()): View {
    const lines = [`📜 <b>${escapeHtml(r.name)}</b> · last ${runs.length} run${runs.length === 1 ? '' : 's'}`, '']
    if (!runs.length) lines.push('never ran')
    for (const run of runs) lines.push(runLine(run, timeZone, now))
    return [text(lines.join('\n')), backToCard(r.name)]
}

const itemLine = (item: Item, isNew: boolean) =>
    `${isNew ? '🆕' : '·'} ${item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}${item.seen_before ? ' (changed)' : ''}`

/** What the pipeline's steps find now: the scripts' output and the sources' items, new ones marked. */
export function previewText(r: RoutineView, preview: Preview, max = 15): View {
    const fresh = new Set(preview.new_keys)
    const lines = [`👁 <b>${escapeHtml(r.name)}</b> · ${preview.ms} ms`, '']
    for (const out of preview.outputs) {
        const body = out.output.trim()
        lines.push(`<b>${escapeHtml(out.name)}</b>${out.truncated ? ' (cut)' : ''}`)
        lines.push(
            body ? `<pre>${escapeHtml(body.slice(0, 1500))}${body.length > 1500 ? '…' : ''}</pre>` : '(no output)'
        )
        lines.push('')
    }
    if (r.steps.some((s) => s.source)) {
        lines.push(
            `${preview.items.length} item${preview.items.length === 1 ? '' : 's'}, ${preview.new_keys.length} would be handed over`
        )
        if (!preview.items.length) lines.push('The sources found nothing.')
        for (const item of preview.items.slice(0, max)) lines.push(itemLine(item, fresh.has(item.key)))
        if (preview.items.length > max) lines.push(`… and ${preview.items.length - max} more`)
    }
    return [text(lines.join('\n').trim()), backToCard(r.name)]
}

/** The button row under a runs or preview message: back to the card. */
export const backToCard = (name: string) => row({ text: '« Back', data: routineData('card', name) })

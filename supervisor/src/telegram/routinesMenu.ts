import { createHash } from 'node:crypto'

import { InlineKeyboard } from 'grammy'

import type { Item } from '../routines/prefilters.js'
import type { Preview, RoutineView } from '../routines/service.js'
import type { RoutineRun } from '../store/index.js'

/**
 * The routines on buttons: `/routines` lists them, a tap opens the routine's
 * card (state, agent, triggers, last and next run), and the card's buttons
 * run it, switch it on or off, preview what a poll would hand over, show the
 * last runs. One message, edited in place. Callback data is `r|<action>|<key>`
 * (64 bytes at most), so a long name travels as a hash of itself.
 */

/** `list`, `card`, `run`, `on`, `off`, `preview` and `runs` edit the menu message; `open` and `fire` sit under a report or a notice and send a new one. */
export type RoutineAction = 'list' | 'card' | 'run' | 'on' | 'off' | 'preview' | 'runs' | 'open' | 'fire'

const DATA_MAX = 64
const hashed = (name: string) => createHash('sha1').update(name).digest('hex').slice(0, 12)

/** The key a routine's buttons carry: the name itself when it fits, its hash otherwise. */
export function routineKey(name: string): string {
    return Buffer.byteLength(`r|preview|${name}`) <= DATA_MAX ? name : hashed(name)
}

export const routineData = (action: RoutineAction, name?: string): string =>
    name === undefined ? `r|${action}` : `r|${action}|${routineKey(name)}`

/** The routine a button's key names. */
export function findRoutine(list: RoutineView[], key: string): RoutineView | undefined {
    return list.find((r) => r.name === key) ?? list.find((r) => hashed(r.name) === key)
}

export function parseRoutineData(data: string): { action: RoutineAction; key: string | null } | null {
    const [kind, action, key] = data.split('|')
    if (kind !== 'r' || !action) return null
    return { action: action as RoutineAction, key: key ?? null }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
    const by = run.trigger === 'manual' ? ' (by hand)' : run.trigger === 'poll' ? ` (${run.items} new)` : ''
    return `${RUN_ICON[run.status]} ${clockAt(run.fired_at, timeZone)} · ${span(run.fired_at, now)} ago${by}: ${escapeHtml(outcome)}`
}

const whenText = (r: RoutineView) =>
    r.triggers.map((t) => (t.kind === 'poll' ? `poll ${t.cron_text}` : t.cron_text)).join('; ') || 'by hand only'

/** The last run and the next firing in a few words. */
function lastAndNext(r: RoutineView, now: number): string {
    const last = r.last_run
        ? `last ${r.last_run.status === 'queued' ? (r.last_run.task_status ?? 'queued') : r.last_run.status} ${span(r.last_run.fired_at, now)} ago`
        : 'never ran'
    const next = r.next_run ? `next in ${span(r.next_run, now)}` : null
    return [last, next].filter(Boolean).join(' · ')
}

/** `/routines`: every routine on a line and a button, tapped for its card. */
export function routinesList(list: RoutineView[], now = Date.now()): { text: string; keyboard: InlineKeyboard } {
    const keyboard = new InlineKeyboard()
    if (!list.length)
        return {
            text: 'No routines yet — create one in the web UI (Routines).',
            keyboard: keyboard.text('🔄 Refresh', routineData('list'))
        }
    const on = list.filter((r) => r.enabled && !r.errors.length).length
    const lines = [`<b>Routines</b> · ${list.length}, ${on} on`, '']
    for (const r of list) {
        const who = [r.agent, r.project].filter(Boolean).join(' · ')
        lines.push(
            `${routineState(r)} <b>${escapeHtml(r.name)}</b>${who ? ` — ${escapeHtml(who)}` : ''}`,
            `      ${escapeHtml(whenText(r))} · ${lastAndNext(r, now)}`
        )
        keyboard.text(`${routineState(r)} ${r.name}`.slice(0, 60), routineData('card', r.name)).row()
    }
    lines.push('', 'Tap a routine: details, Run now, on / off, preview, last runs.')
    keyboard.text('🔄 Refresh', routineData('list'))
    return { text: lines.join('\n'), keyboard }
}

/** A routine's card: what it is, how it stands, and the buttons that act on it. */
export function routineCard(
    r: RoutineView,
    timeZone: string,
    options: { note?: string; webUrl?: string | null; now?: number } = {}
): { text: string; keyboard: InlineKeyboard } {
    const now = options.now ?? Date.now()
    const lines = [`${routineState(r)} <b>${escapeHtml(r.name)}</b> · ${stateWord(r)}`]
    if (r.errors.length) lines.push(`⚠️ ${escapeHtml(r.errors.join('; '))}`)
    for (const w of r.warnings) lines.push(`⚠️ ${escapeHtml(w)}`)
    const facts = [
        r.agent ? `agent: ${r.agent}` : null,
        r.skill ? `skill: ${r.skill}` : null,
        r.project ? `project: ${r.project}` : null,
        r.provider ? `on ${r.provider}${r.model ? ` · ${r.model}` : ''}` : r.model ? `model: ${r.model}` : null
    ].filter(Boolean)
    if (facts.length) lines.push(escapeHtml(facts.join(' · ')))
    lines.push(`triggers: ${escapeHtml(whenText(r))}${r.once ? ' · once' : ''}`)
    if (r.last_run) lines.push(runLine(r.last_run, timeZone, now).replace(/^(\S+) /, '$1 last run '))
    else lines.push('never ran')
    if (r.next_run) lines.push(`next: ${clockAt(r.next_run, timeZone)} (in ${span(r.next_run, now)})`)
    if (options.note) lines.push('', options.note)

    const keyboard = new InlineKeyboard()
    if (r.active_task) keyboard.text('⏹ Stop the run', `s|stop|${r.active_task.id}`).danger().row()
    else if (!r.errors.length) keyboard.text('▶️ Run now', routineData('run', r.name)).success().row()
    if (!r.errors.length)
        keyboard.text(r.enabled ? '⏸ Switch off' : '▶ Switch on', routineData(r.enabled ? 'off' : 'on', r.name))
    if (r.prefilter) keyboard.text('👁 Preview', routineData('preview', r.name))
    keyboard.text('📜 Runs', routineData('runs', r.name)).row()
    if (options.webUrl) keyboard.url('🌐 Open', `${options.webUrl}/routines/${encodeURIComponent(r.name)}`)
    keyboard.text('« Routines', routineData('list'))
    return { text: lines.join('\n'), keyboard }
}

/** The last runs of a routine, newest first. */
export function runsText(r: RoutineView, runs: RoutineRun[], timeZone: string, now = Date.now()): string {
    const lines = [`📜 <b>${escapeHtml(r.name)}</b> · last ${runs.length} run${runs.length === 1 ? '' : 's'}`, '']
    if (!runs.length) lines.push('never ran')
    for (const run of runs) lines.push(runLine(run, timeZone, now))
    return lines.join('\n')
}

const itemLine = (item: Item, isNew: boolean) =>
    `${isNew ? '🆕' : '·'} ${item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}${item.seen_before ? ' (changed)' : ''}`

/** What a poll would hand over now. */
export function previewText(r: RoutineView, preview: Preview, max = 15): string {
    const fresh = new Set(preview.new_keys)
    const lines = [
        `👁 <b>${escapeHtml(r.name)}</b> · ${preview.items.length} item${preview.items.length === 1 ? '' : 's'}, ${preview.new_keys.length} new (${preview.ms} ms)`,
        ''
    ]
    if (!preview.items.length) lines.push('The prefilter found nothing.')
    for (const item of preview.items.slice(0, max)) lines.push(itemLine(item, fresh.has(item.key)))
    if (preview.items.length > max) lines.push(`… and ${preview.items.length - max} more`)
    return lines.join('\n')
}

/** The keyboard under a runs or preview message: back to the card. */
export const backToCard = (name: string): InlineKeyboard =>
    new InlineKeyboard().text('« Back', routineData('card', name))

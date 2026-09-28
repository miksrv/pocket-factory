import { useState } from 'react'
import { Link } from 'react-router-dom'

import { api, fmt, type RateLimits } from '../lib/api'
import { Tile } from './Tile'

/** Colour band for a window: calm until half, then amber, then red. */
function tone(used: number): string {
    return used >= 0.85 ? 'red' : used >= 0.6 ? 'amber' : 'green'
}

export function LimitMeter({ label, window }: { label: string; window: RateLimits['five_hour'] }) {
    if (!window) {
        return (
            <div className="meter">
                <div className="meter-head">
                    <span>{label}</span>
                    <span className="dim">not reported</span>
                </div>
                <div className="meter-bar" />
            </div>
        )
    }
    const used = Math.min(1, Math.max(0, window.used))
    return (
        <div className="meter">
            <div className="meter-head">
                <span>{label}</span>
                <span>
                    <strong>{fmt.pct(used)}</strong> <span className="dim">used · resets in {fmt.until(window.resets_at)}</span>
                </span>
            </div>
            <div className={`meter-bar ${tone(used)}`} title={`${fmt.pct(used)} · resets ${new Date(window.resets_at).toLocaleString()}`}>
                <div className="meter-fill" style={{ width: `${used * 100}%` }} />
            </div>
        </div>
    )
}

/**
 * The two subscription windows with a refresh button. Readings come from the
 * CLI's rate-limit events, so they update with every task; the probe spends
 * one Haiku turn when there has been no task for a while.
 */
export function LimitsCard({ limits, onChange }: { limits: RateLimits | null | undefined; onChange?: (limits: RateLimits) => void }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const probe = async () => {
        setBusy(true)
        setError(null)
        try {
            onChange?.(await api.probeUsage())
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="card pad0">
            <div className="card-head">
                <span className="row">
                    <Tile icon="limits" color={limits ? (tone(Math.max(limits.five_hour?.used ?? 0, limits.seven_day?.used ?? 0)) as 'green' | 'amber' | 'red') : 'gray'} small />
                    Subscription limits
                </span>
                <button className="sm" onClick={probe} disabled={busy} title="Runs one Haiku turn to read the current limits">
                    {busy ? 'Asking the CLI…' : 'Refresh'}
                </button>
            </div>
            <div className="meters">
                <LimitMeter label="5-hour window" window={limits?.five_hour ?? null} />
                <LimitMeter label="Weekly window" window={limits?.seven_day ?? null} />
            </div>
            <div className="card-foot">
                <span>
                    {limits
                        ? <>As of {fmt.ago(limits.ts)}{limits.task_id ? <> · from task <Link to={`/tasks/${limits.task_id}`}>{limits.task_id.slice(0, 8)}</Link></> : ' · from a probe'}{limits.status !== 'allowed' ? <> · <span className="error">{limits.status}</span></> : null}</>
                        : 'No reading yet — the CLI reports limits with the first task, or press Refresh.'}
                </span>
                {error ? <span className="error">{error}</span> : <span>Reported by the CLI after each API call; shared with every Claude Code client on this account.</span>}
            </div>
        </div>
    )
}

/** Compact "5h 12% · 7d 31%" for the sidebar and headers. */
export function LimitsInline({ limits }: { limits: RateLimits | null | undefined }) {
    if (!limits || (!limits.five_hour && !limits.seven_day)) return null
    return (
        <span className="limits-inline" title={`Subscription limits as of ${new Date(limits.ts).toLocaleString()}`}>
            {limits.five_hour && (
                <span className={`badge plain ${tone(limits.five_hour.used)}`}>5h {fmt.pct(limits.five_hour.used)}</span>
            )}
            {limits.seven_day && (
                <span className={`badge plain ${tone(limits.seven_day.used)}`}>7d {fmt.pct(limits.seven_day.used)}</span>
            )}
        </span>
    )
}

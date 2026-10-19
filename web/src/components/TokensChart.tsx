import { useEffect, useRef, useState } from 'react'

import { api, type DailyRange, type DailyTokens, fmt } from '../lib/api'
import type { DailyChartHandle } from '../lib/charts'
import { onThemeChange } from '../lib/theme'
import { useAsync } from '../lib/useAsync'
import { Tile } from './Tile'
import { Empty, ErrorBox, Tabs } from './ui'

/** jsdom has no layout for a chart: tests read the same numbers as a table. */
const RICH = typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)

const RANGES: ReadonlyArray<{ value: `${DailyRange}`; label: string }> = [
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' }
]

const swatch = (slot: number | null) => ({ background: slot ? `var(--chart-${slot})` : 'var(--gray)' })

/**
 * Tokens per day as stacked bars: the subscription's model families and each provider, colours
 * fixed per family / provider so a range without one never repaints the rest. The legend under
 * the chart carries every series' total, so nothing is read from colour or hover alone.
 */
export function TokensChart() {
    const [range, setRange] = useState<`${DailyRange}`>('30')
    const daily = useAsync(() => api.dailyTokens(Number(range) as DailyRange), [range], 60_000)
    const data = daily.data
    const total = data?.series.reduce((n, s) => n + s.total, 0) ?? 0

    return (
        <div className='card pad0 tokens-card'>
            <div className='card-head'>
                <span className='row'>
                    <Tile
                        icon='usage'
                        color='gray'
                        small
                    />
                    Tokens by day
                </span>
                <Tabs
                    items={RANGES}
                    value={range}
                    onChange={setRange}
                />
            </div>
            {daily.error ? (
                <div className='card-row'>
                    <ErrorBox
                        error={daily.error}
                        inline
                    />
                </div>
            ) : !data ? (
                <div className='chart-body chart-wait' />
            ) : !data.series.length ? (
                <div className='card-row'>
                    <Empty inline>No model calls in the last {range} days.</Empty>
                </div>
            ) : (
                <>
                    {RICH ? <DailyChart data={data} /> : <DailyTable data={data} />}
                    <div className='chart-legend'>
                        {data.series.map((s) => (
                            <span
                                key={s.key}
                                className='chart-legend-item'
                                title={s.kind === 'provider' ? `provider ${s.label}` : `${s.label} on the subscription`}
                            >
                                <i
                                    className='chart-swatch'
                                    style={swatch(s.slot)}
                                />
                                {s.label}
                                <strong>{fmt.tokens(s.total)}</strong>
                            </span>
                        ))}
                    </div>
                </>
            )}
            <div className='card-foot'>
                <span>Sent, written to the cache and generated, per day; cache reads are not shown.</span>
                {data && <span>{fmt.tokens(total)} in total</span>}
            </div>
        </div>
    )
}

function DailyChart({ data }: { data: DailyTokens }) {
    const host = useRef<HTMLDivElement>(null)
    const chart = useRef<DailyChartHandle | null>(null)
    const latest = useRef(data)
    latest.current = data

    useEffect(() => {
        let cancelled = false
        void import('../lib/charts').then(({ mountDailyChart }) => {
            if (cancelled || !host.current) return
            chart.current = mountDailyChart(host.current, latest.current)
        })
        const unwatch = onThemeChange(() => chart.current?.restyle())
        return () => {
            cancelled = true
            unwatch()
            chart.current?.destroy()
            chart.current = null
        }
    }, [])

    useEffect(() => chart.current?.update(data), [data])

    const total = data.series.reduce((n, s) => n + s.total, 0)
    return (
        <div
            ref={host}
            className='chart-body'
            role='img'
            aria-label={`Tokens per day over ${data.days.length} days, ${fmt.tokens(total)} in total: ${data.series
                .map((s) => `${s.label} ${fmt.tokens(s.total)}`)
                .join(', ')}`}
        />
    )
}

function DailyTable({ data }: { data: DailyTokens }) {
    return (
        <table>
            <thead>
                <tr>
                    <th>Day</th>
                    {data.series.map((s) => (
                        <th key={s.key}>{s.label}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {data.days.map((day, i) => (
                    <tr key={day}>
                        <td>{day}</td>
                        {data.series.map((s) => (
                            <td key={s.key}>{s.values[i]}</td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

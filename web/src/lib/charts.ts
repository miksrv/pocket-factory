/**
 * ECharts, loaded as its own chunk the first time a chart mounts (like `codemirror.ts`): only the
 * pieces the factory draws, rendered as SVG. Colours are never written here: every one is read
 * from the stylesheet's tokens when the chart is drawn, and again when the theme changes.
 */
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

import { type DailyTokens, fmt } from './api'

echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer])

export interface DailyChartHandle {
    update(data: DailyTokens): void
    /** Re-read the tokens (a theme change). */
    restyle(): void
    destroy(): void
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** A series' colour: its slot of the palette, gray past it. */
const seriesColor = (slot: number | null) => (slot ? `var(--chart-${slot})` : 'var(--gray)')

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** "Oct 6" for the axis, "Mon, Oct 6" for the tooltip; the date is the owner's, so it is read as UTC. */
const dayLabel = (date: string, weekday = false) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        ...(weekday ? { weekday: 'short' } : {})
    })

function option(data: DailyTokens): echarts.EChartsCoreOption {
    const ink = token('--text')
    const dim = token('--text-dim')
    const font = token('--mono')
    const surface = token('--surface')
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    // Only the top segment of a day's stack is rounded, so the column reads as one bar.
    const top = data.days.map((_, day) => {
        for (let i = data.series.length - 1; i >= 0; i--) if (data.series[i].values[day] > 0) return i
        return -1
    })
    return {
        animation: !still,
        animationDuration: 300,
        textStyle: { fontFamily: font, color: dim, fontSize: 11 },
        grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
        xAxis: {
            type: 'category',
            data: data.days,
            axisTick: { show: false },
            axisLine: { lineStyle: { color: token('--border-strong') } },
            axisLabel: { color: dim, fontSize: 11, hideOverlap: true, formatter: (d: string) => dayLabel(d) }
        },
        yAxis: {
            type: 'value',
            splitNumber: 3,
            axisLabel: { color: dim, fontSize: 11, formatter: fmt.tokens },
            splitLine: { lineStyle: { color: token('--border'), type: 'dashed' } }
        },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow', shadowStyle: { color: token('--surface-3'), opacity: 0.6 } },
            backgroundColor: surface,
            borderColor: token('--border-strong'),
            borderWidth: 1,
            padding: [8, 10],
            textStyle: { color: ink, fontFamily: font, fontSize: 12 },
            extraCssText: 'box-shadow: var(--shadow); border-radius: var(--radius-sm);',
            formatter: (params: unknown) => {
                const day = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0
                const rows = data.series.filter((s) => s.values[day] > 0)
                const total = rows.reduce((n, s) => n + s.values[day], 0)
                const line = (swatch: string, label: string, value: number, strong = false) =>
                    `<div class="chart-tip-row${strong ? ' total' : ''}">${swatch}<span>${escape(label)}</span><span>${fmt.tokens(value)}</span></div>`
                return [
                    `<div class="chart-tip-head">${dayLabel(data.days[day], true)}</div>`,
                    ...rows
                        .slice()
                        .reverse()
                        .map((s) =>
                            line(
                                `<i class="chart-swatch" style="background:${seriesColor(s.slot)}"></i>`,
                                s.label,
                                s.values[day]
                            )
                        ),
                    rows.length > 1 ? line('<i class="chart-swatch"></i>', 'Total', total, true) : '',
                    rows.length ? '' : '<div class="chart-tip-row">no model calls</div>'
                ].join('')
            }
        },
        series: data.series.map((s, i) => ({
            name: s.label,
            type: 'bar',
            stack: 'tokens',
            barMaxWidth: 22,
            barCategoryGap: '30%',
            color: s.slot ? token(`--chart-${s.slot}`) : token('--gray'),
            // A surface-coloured edge keeps a hairline between stacked segments.
            itemStyle: { borderColor: surface, borderWidth: 1 },
            emphasis: { disabled: true },
            // A day without calls draws nothing (a zero bar would still show its edge).
            data: s.values.map((value, day) => ({
                value: value || null,
                itemStyle: top[day] === i ? { borderRadius: [4, 4, 0, 0] } : undefined
            }))
        }))
    }
}

export function mountDailyChart(host: HTMLElement, data: DailyTokens): DailyChartHandle {
    const chart = echarts.init(host, null, { renderer: 'svg' })
    let current = data
    chart.setOption(option(current))
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(host)
    return {
        update(next) {
            current = next
            // notMerge: a series that left the range must leave the chart too.
            chart.setOption(option(current), { notMerge: true })
        },
        restyle() {
            chart.setOption(option(current), { notMerge: true })
        },
        destroy() {
            resize.disconnect()
            chart.dispose()
        }
    }
}

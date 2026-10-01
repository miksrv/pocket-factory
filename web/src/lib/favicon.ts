/**
 * The browser tab's icon doubles as a notification badge, the way mail and
 * chat apps do it: a tab title gets truncated once a few tabs are open and a
 * pinned tab shows no title at all, but the icon is always there. The badge
 * follows the sidebar's Chat item: a count on green for unread replies, on
 * amber for a question waiting, a small blue dot while a task runs.
 */

export type FaviconBadge = { kind: 'unread' | 'ask'; count: number } | { kind: 'running' } | null

const SIZE = 64
// The same PNG the <link rel="icon"> tags in index.html use (docs/brand/logo.png, cut to 64 px).
const LOGO_SRC = '/icon-64.png'
// Brighter than the UI's status colours on purpose: the badge sits on the ink tile, not on paper,
// and the tab renders it at 16 px. A pale ring separates it from the tile; the count is in ink.
const COLORS = { unread: '#34d35e', ask: '#ffa726', running: '#4f9cff' }
const RING = '#f7f6f2'

let plain: string | null = null
let last = ''
let logo: HTMLImageElement | null = null

function withLogo(fn: (img: HTMLImageElement) => void): void {
    if (logo?.complete && logo.naturalWidth > 0) return fn(logo)
    if (!logo) {
        logo = new Image()
        logo.src = LOGO_SRC
    }
    logo.addEventListener('load', () => fn(logo!), { once: true })
}

function link(): HTMLLinkElement {
    let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!el) {
        el = document.createElement('link')
        el.rel = 'icon'
        document.head.appendChild(el)
    }
    return el
}

export function setFaviconBadge(badge: FaviconBadge): void {
    const key = JSON.stringify(badge)
    if (key === last) return
    last = key
    const el = link()
    if (plain === null) plain = el.href
    if (!badge) {
        el.href = plain
        return
    }
    withLogo((img) => {
        if (key !== last) return // superseded while the image was loading
        draw(el, img, badge)
    })
}

function draw(el: HTMLLinkElement, img: HTMLImageElement, badge: NonNullable<FaviconBadge>): void {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, SIZE, SIZE)
    const s = SIZE / 100
    ctx.scale(s, s)

    if (badge.kind === 'running') {
        ctx.fillStyle = RING
        ctx.beginPath()
        ctx.arc(76, 24, 24, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = COLORS.running
        ctx.beginPath()
        ctx.arc(76, 24, 18, 0, Math.PI * 2)
        ctx.fill()
    } else {
        const text = badge.count > 9 ? '9+' : String(badge.count)
        // A circle for one digit, a pill for "9+"; both overhang the top-right corner a little.
        const w = text.length > 1 ? 58 : 44
        const h = 44
        const x = 100 - w + 6
        const y = -6
        ctx.fillStyle = RING
        ctx.beginPath()
        ctx.roundRect(x - 5, y - 5, w + 10, h + 10, (h + 10) / 2)
        ctx.fill()
        ctx.fillStyle = COLORS[badge.kind]
        ctx.beginPath()
        ctx.roundRect(x, y, w, h, h / 2)
        ctx.fill()
        ctx.fillStyle = '#1d1d1b'
        ctx.font = 'bold 34px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + w / 2, y + h / 2 + 2)
    }
    el.href = canvas.toDataURL('image/png')
}

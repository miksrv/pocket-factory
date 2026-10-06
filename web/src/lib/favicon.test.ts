import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * jsdom has no canvas and loads no images, so the test gives the module a
 * logo that is already loaded and a 2D context that records the text drawn;
 * what it checks is the icon the tab ends up with.
 */
function stubCanvas() {
    const texts: string[] = []
    const context = new Proxy(
        { fillText: (text: string) => texts.push(text) },
        { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) }
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    let n = 0
    const toDataURL = vi
        .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
        .mockImplementation(() => `data:image/png;base64,badge${++n}`)
    class LoadedImage {
        complete = true
        naturalWidth = 64
        src = ''
        // Loads at once: the listener the module adds for the first badge runs right away.
        addEventListener(_type: string, listener: () => void) {
            listener()
        }
    }
    vi.stubGlobal('Image', LoadedImage)
    return { texts, toDataURL }
}

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!

describe('setFaviconBadge', () => {
    beforeEach(() => {
        vi.resetModules()
        document.head.innerHTML = '<link rel="icon" href="/favicon-32.png">'
    })

    it('draws the unread count over the logo and puts the plain icon back when cleared', async () => {
        const { texts } = stubCanvas()
        const { setFaviconBadge } = await import('./favicon')
        setFaviconBadge({ kind: 'unread', count: 3 })
        expect(icon().href).toBe('data:image/png;base64,badge1')
        expect(texts).toEqual(['3'])
        setFaviconBadge(null)
        expect(icon().href).toBe(`${window.location.origin}/favicon-32.png`)
    })

    it('caps the count at 9+', async () => {
        const { texts } = stubCanvas()
        const { setFaviconBadge } = await import('./favicon')
        setFaviconBadge({ kind: 'ask', count: 12 })
        expect(texts).toEqual(['9+'])
    })

    it('draws a dot without a number while a task runs', async () => {
        const { texts, toDataURL } = stubCanvas()
        const { setFaviconBadge } = await import('./favicon')
        setFaviconBadge({ kind: 'running' })
        expect(toDataURL).toHaveBeenCalledOnce()
        expect(texts).toEqual([])
    })

    it('does not redraw the same badge', async () => {
        const { toDataURL } = stubCanvas()
        const { setFaviconBadge } = await import('./favicon')
        setFaviconBadge({ kind: 'unread', count: 1 })
        setFaviconBadge({ kind: 'unread', count: 1 })
        expect(toDataURL).toHaveBeenCalledOnce()
        setFaviconBadge({ kind: 'unread', count: 2 })
        expect(toDataURL).toHaveBeenCalledTimes(2)
    })

    it('adds an icon link when the page has none', async () => {
        document.head.innerHTML = ''
        stubCanvas()
        const { setFaviconBadge } = await import('./favicon')
        setFaviconBadge({ kind: 'running' })
        expect(icon().href).toMatch(/^data:image\/png/)
    })
})

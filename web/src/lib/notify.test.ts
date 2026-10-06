import { beforeEach, describe, expect, it, vi } from 'vitest'

type Permission = 'default' | 'granted' | 'denied'

/** A stand-in for the Web Notifications API: records what was shown, answers the permission prompt with `answer`. */
function stubNotification(permission: Permission, answer: Permission = permission) {
    const shown: FakeNotification[] = []
    class FakeNotification {
        static permission: Permission = permission
        static requestPermission = vi.fn(() => {
            FakeNotification.permission = answer
            return Promise.resolve(answer)
        })
        onclick: (() => void) | null = null
        close = vi.fn()
        constructor(
            public title: string,
            public options: NotificationOptions
        ) {
            shown.push(this)
        }
    }
    vi.stubGlobal('Notification', FakeNotification)
    return { Notification: FakeNotification, shown }
}

/** notify.ts checks for the API once, at import: load a fresh copy after stubbing. */
const load = () => import('./notify')

const setVisibility = (state: DocumentVisibilityState) =>
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)

describe('notify', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    it('does nothing where the API does not exist', async () => {
        const notify = await load()
        expect(notify.notificationsSupported).toBe(false)
        expect(notify.notificationsEnabled()).toBe(false)
        expect(notify.notificationsBlocked()).toBe(false)
        await expect(notify.toggleNotifications()).resolves.toBe(false)
    })

    it('asks the browser on the first switch-on and remembers the choice', async () => {
        const { Notification } = stubNotification('default', 'granted')
        const notify = await load()
        expect(notify.notificationsEnabled()).toBe(false)
        await expect(notify.toggleNotifications()).resolves.toBe(true)
        expect(Notification.requestPermission).toHaveBeenCalledOnce()
        expect(notify.notificationsEnabled()).toBe(true)
        expect(localStorage.getItem('pf.notify')).toBe('1')
    })

    it('stays off when the browser is refused', async () => {
        stubNotification('default', 'denied')
        const notify = await load()
        await expect(notify.toggleNotifications()).resolves.toBe(false)
        expect(notify.notificationsEnabled()).toBe(false)
        expect(notify.notificationsBlocked()).toBe(true)
    })

    it('does not ask again once blocked', async () => {
        const { Notification } = stubNotification('denied')
        const notify = await load()
        await expect(notify.toggleNotifications()).resolves.toBe(false)
        expect(Notification.requestPermission).not.toHaveBeenCalled()
    })

    it('switches off without touching the permission', async () => {
        const { Notification } = stubNotification('granted')
        const notify = await load()
        expect(notify.notificationsEnabled()).toBe(true)
        await expect(notify.toggleNotifications()).resolves.toBe(false)
        expect(notify.notificationsEnabled()).toBe(false)
        expect(localStorage.getItem('pf.notify')).toBe('0')
        await expect(notify.toggleNotifications()).resolves.toBe(true)
        expect(Notification.requestPermission).not.toHaveBeenCalled()
    })

    it('shows a notification only while the tab is hidden', async () => {
        const { shown } = stubNotification('granted')
        const notify = await load()
        setVisibility('visible')
        notify.notify('Reply', 'done', 'chat')
        expect(shown).toHaveLength(0)
        setVisibility('hidden')
        notify.notify('Reply in pf', 'The task is done', 'chat')
        expect(shown).toHaveLength(1)
        expect(shown[0].title).toBe('Reply in pf')
        expect(shown[0].options).toMatchObject({ body: 'The task is done', tag: 'chat' })
    })

    it('stays quiet when switched off', async () => {
        const { shown } = stubNotification('granted')
        localStorage.setItem('pf.notify', '0')
        const notify = await load()
        setVisibility('hidden')
        notify.notify('Reply', 'done', 'chat')
        expect(shown).toHaveLength(0)
    })

    it('focuses the tab and opens the thread on a click', async () => {
        const { shown } = stubNotification('granted')
        const notify = await load()
        setVisibility('hidden')
        const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
        const open = vi.fn()
        notify.notify('Reply', 'done', 'chat', open)
        shown[0].onclick!()
        expect(focus).toHaveBeenCalled()
        expect(open).toHaveBeenCalledOnce()
        expect(shown[0].close).toHaveBeenCalled()
    })

    it('swallows a constructor that throws (Android Chrome)', async () => {
        stubNotification('granted')
        vi.stubGlobal(
            'Notification',
            Object.assign(
                function () {
                    throw new TypeError('Illegal constructor')
                },
                { permission: 'granted' }
            )
        )
        const notify = await load()
        setVisibility('hidden')
        expect(() => notify.notify('Reply', 'done', 'chat')).not.toThrow()
    })
})

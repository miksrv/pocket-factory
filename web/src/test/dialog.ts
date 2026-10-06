/**
 * A minimal stand-in for the parts of HTMLDialogElement that jsdom lacks
 * (`showModal`, `show`, `close`, the `cancel` on Escape), enough for
 * components/Modal.tsx: the `open` attribute follows the calls, `close()`
 * fires `close`, and Escape on an open modal fires a cancelable `cancel`
 * that closes the element unless prevented, like a browser does. No top
 * layer, no inert background, no focus trap.
 */
export function installDialogPolyfill(): void {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & { __polyfilled?: boolean }
    if (typeof proto.showModal === 'function' || proto.__polyfilled) return
    proto.__polyfilled = true

    if (!Object.getOwnPropertyDescriptor(proto, 'open')) {
        Object.defineProperty(proto, 'open', {
            configurable: true,
            get(this: HTMLDialogElement) {
                return this.hasAttribute('open')
            },
            set(this: HTMLDialogElement, value: boolean) {
                this.toggleAttribute('open', Boolean(value))
            }
        })
    }

    const modals: HTMLDialogElement[] = []

    proto.show = function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
    }
    proto.showModal = function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) throw new DOMException('The dialog is already open', 'InvalidStateError')
        this.setAttribute('open', '')
        modals.push(this)
    }
    proto.close = function (this: HTMLDialogElement, returnValue?: string) {
        if (!this.hasAttribute('open')) return
        if (returnValue !== undefined) this.returnValue = returnValue
        this.removeAttribute('open')
        const index = modals.indexOf(this)
        if (index >= 0) modals.splice(index, 1)
        this.dispatchEvent(new Event('close'))
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        const top = modals[modals.length - 1]
        if (!top) return
        const proceed = top.dispatchEvent(new Event('cancel', { cancelable: true }))
        if (proceed) top.close()
    })
}

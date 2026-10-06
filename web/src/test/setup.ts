import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { installDialogPolyfill } from './dialog'

import '@testing-library/jest-dom/vitest'

// jsdom has no showModal / close on <dialog> yet; Modal.tsx needs both.
installDialogPolyfill()

afterEach(() => {
    cleanup()
    localStorage.clear()
})

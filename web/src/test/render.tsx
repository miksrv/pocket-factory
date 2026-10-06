import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, type RenderOptions } from '@testing-library/react'

import { ConfirmProvider } from '../components/Modal'

/** Render inside a MemoryRouter (at `route`) and the app's ConfirmProvider, as `App` mounts them. */
export function renderWithProviders(
    ui: ReactElement,
    { route = '/', ...options }: { route?: string } & Omit<RenderOptions, 'wrapper'> = {}
) {
    const Wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[route]}>
            <ConfirmProvider>{children}</ConfirmProvider>
        </MemoryRouter>
    )
    return render(ui, { wrapper: Wrapper, ...options })
}

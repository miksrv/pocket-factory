import type { RoutineRun } from './api'

/** Where a run whose steps are going is: "step 3 of 6 · Google Search Console"; null once they are done. */
export function runProgress(run: RoutineRun | null | undefined, total: number): string | null {
    if (run?.status !== 'running') return null
    const current = run.steps?.find((s) => s.running)
    return current ? `step ${current.index + 1} of ${total} · ${current.name}` : 'starting the steps'
}

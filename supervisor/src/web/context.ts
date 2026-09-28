import type { Config } from '../config.js'
import type { Catalog } from '../files/catalog.js'
import type { History } from '../files/history.js'
import type { Presets } from '../presets/index.js'
import type { Transcripts } from '../sessions/transcripts.js'
import type { Store } from '../store/index.js'
import type { TaskService } from '../tasks/service.js'

/** Everything the HTTP routes need; assembled once in index.ts. */
export interface AppContext {
    config: Config
    store: Store
    tasks: TaskService
    catalog: Catalog
    history: History
    transcripts: Transcripts
    presets: Presets
}

export type Env = { Variables: { app: AppContext } }

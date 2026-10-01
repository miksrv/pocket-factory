import type { Config } from '../config.js'
import type { Catalog } from '../files/catalog.js'
import type { Hosts } from '../files/hosts.js'
import type { KnownHosts } from '../files/knownHosts.js'
import type { Presets } from '../presets/index.js'
import type { Schedules } from '../schedules/service.js'
import type { Transcripts } from '../sessions/transcripts.js'
import type { Store } from '../store/index.js'
import type { TaskService } from '../tasks/service.js'

/** Everything the HTTP routes need; assembled once in index.ts. */
export interface AppContext {
    config: Config
    store: Store
    tasks: TaskService
    catalog: Catalog
    hosts: Hosts
    knownHosts: KnownHosts
    transcripts: Transcripts
    presets: Presets
    schedules: Schedules
}

export type Env = { Variables: { app: AppContext } }

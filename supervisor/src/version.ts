import fs from 'node:fs'
import path from 'node:path'

/**
 * The factory's own version: `version` in the root `package.json` (the one
 * source; `scripts/release.mjs bump` keeps the workspaces in step). The file
 * sits in the working directory both ways the supervisor runs: `/app` in the
 * image (the Dockerfile copies it) and the checkout under `yarn dev`.
 */
function read(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === 'pocket-factory' && typeof pkg.version === 'string') return pkg.version
    } catch {
        // fall through: a build layout without the root package.json
    }
    return '0.0.0'
}

export const VERSION = read()

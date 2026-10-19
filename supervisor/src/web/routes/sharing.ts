import { Hono } from 'hono'

import { BadName } from '../../files/catalog.js'
import { createLogger } from '../../logger.js'
import {
    type Bundle,
    type BundleItem,
    exportBundle,
    installBundle,
    itemKey,
    itemNeeds,
    readBundle,
    readMarkdownBundle,
    routineRefs
} from '../../sharing/bundle.js'
import { isZip, readZip, ZipError } from '../../sharing/zip.js'
import type { Env } from '../context.js'

const log = createLogger('sharing')

/** Stray files a preview lists by name; the rest only counted. */
const IGNORED_SHOWN = 30

/**
 * Sharing agents, skills and routines between factories: an export is a ZIP
 * in the preset layout; an import takes such a ZIP, a `.skill` file, or one
 * Markdown file (a skill, or an agent), shows what it would do, then installs
 * what the owner ticked.
 */
export function sharingRoutes(): Hono<Env> {
    const app = new Hono<Env>()

    app.post('/export', async (c) => {
        const { catalog, vault } = c.get('app')
        const body = (await c.req.json().catch(() => ({}))) as {
            agents?: unknown
            skills?: unknown
            routines?: unknown
            with_deps?: unknown
            with_data?: unknown
            title?: unknown
        }
        const names = (value: unknown) =>
            Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
        const request = {
            agents: names(body.agents),
            skills: names(body.skills),
            routines: names(body.routines),
            withDeps: body.with_deps !== false,
            withData: body.with_data === true,
            title: typeof body.title === 'string' ? body.title : undefined
        }
        if (!request.agents.length && !request.skills.length && !request.routines.length)
            return c.json({ error: 'nothing to export: pick an agent, a skill or a routine' }, 400)
        const { bytes, filename, masked } = exportBundle(catalog, vault, request)
        if (masked.length) log.info(`export ${filename}: secret values masked in ${masked.join(', ')}`)
        return c.body(new Uint8Array(bytes), 200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${filename}"`,
            'x-masked-files': String(masked.length)
        })
    })

    // ?file=<name> the uploaded file's name; ?as=skills|agents for one Markdown file;
    // ?install=<kind/name,…> installs those items (an existing one is replaced), else only the preview.
    app.post('/import', async (c) => {
        const { catalog, vault } = c.get('app')
        const file = c.req.query('file') ?? 'import'
        const as = c.req.query('as') === 'agents' ? 'agents' : 'skills'
        const bytes = Buffer.from(await c.req.arrayBuffer())
        if (!bytes.length) return c.json({ error: 'the file is empty' }, 400)
        let bundle: Bundle
        try {
            bundle = isZip(bytes)
                ? readBundle(readZip(bytes), file.replace(/\.(zip|skill)$/i, ''))
                : readMarkdownBundle(bytes, file, as)
        } catch (error) {
            if (error instanceof ZipError) return c.json({ error: error.message }, 400)
            throw error
        }
        if (!bundle.items.length)
            return c.json(
                { error: 'nothing to import: no SKILL.md, ROUTINE.md, agents/, skills/ or routines/ in it' },
                400
            )

        const install = c.req.query('install')
        if (install !== undefined) {
            const keys = new Set(install.split(',').filter(Boolean))
            const unknown = [...keys].filter((key) => !bundle.items.some((item) => itemKey(item) === key))
            if (unknown.length) throw new BadName(`not in the file: ${unknown.join(', ')}`)
            const installed = installBundle(bundle, catalog, (item) => keys.has(itemKey(item)))
            log.info(`import ${file}: ${installed.map(itemKey).join(', ') || 'nothing'}`)
            return c.json({ installed })
        }

        const inBundle = (kind: string, name: string) =>
            bundle.items.some((item) => item.kind === kind && item.name === name)
        const notes = (item: BundleItem): string[] => {
            if (item.kind !== 'routines') return []
            const out = ['arrives switched off']
            const refs = routineRefs(item)
            if (refs.agent && !inBundle('agents', refs.agent) && !catalog.exists('agents', refs.agent))
                out.push(`agent “${refs.agent}” is not here: pick one after the import`)
            if (refs.skill && !inBundle('skills', refs.skill) && !catalog.exists('skills', refs.skill))
                out.push(`skill “${refs.skill}” is not here: pick one after the import`)
            if (refs.project && !catalog.exists('projects', refs.project))
                out.push(`project “${refs.project}” is not here: pick one after the import`)
            return out
        }
        return c.json({
            title: bundle.title,
            description: bundle.description,
            items: bundle.items.map((item) => ({
                kind: item.kind,
                name: item.name,
                description:
                    typeof item.doc.frontmatter.description === 'string' ? item.doc.frontmatter.description : null,
                exists: catalog.exists(item.kind, item.name),
                files: item.files.map((f) => f.path),
                needs: itemNeeds(item).map((need) => ({ ...need, set: vault.has(need.name) })),
                errors: item.errors,
                notes: notes(item)
            })),
            ignored: bundle.ignored.slice(0, IGNORED_SHOWN),
            ignored_count: bundle.ignored.length
        })
    })

    return app
}

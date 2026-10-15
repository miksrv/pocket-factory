import type { DelegateAgent } from '../tasks/service.js'
import type { Catalog } from './catalog.js'

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * The roles an orchestrator delegates: agent files with `provider:` (the provider in
 * providers.yaml), `provider_model:` (its model id; empty = the provider's default) and
 * `fallback:` (`inherit` when empty: the orchestrator's model runs the role when the provider cannot).
 */
export function delegateAgents(catalog: Catalog): DelegateAgent[] {
    return catalog.list('agents').flatMap((entry) => {
        const fm = entry.frontmatter
        const provider = text(fm.provider)
        if (!provider) return []
        return [
            {
                name: entry.name,
                description: text(fm.description),
                provider,
                model: text(fm.provider_model) || null,
                fallback: text(fm.fallback) || 'inherit'
            }
        ]
    })
}

/** The providers a project's file lets its tasks delegate to (`providers:` list); null when it names none. */
export function projectProviders(catalog: Catalog, slug: string): string[] | null {
    if (!catalog.exists('projects', slug)) return null
    const list = catalog.get('projects', slug).frontmatter.providers
    return Array.isArray(list) ? list.map(String) : null
}

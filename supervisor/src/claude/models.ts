/**
 * The orchestrator's model is a CLI alias chosen at run time (Telegram
 * `/model`, Settings), kept in `meta` under `claude.model`, never in `.env`:
 * the CLI resolves an alias to the subscription's current model of that tier,
 * so the factory follows releases by itself. Sub-agents keep the `model:` of
 * their own file (`inherit` follows this one); a schedule may pin one for its
 * runs. There is no model list endpoint on purpose (SPEC §8), hence the
 * static list.
 */
export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/** What the factory runs on until the owner picks another alias. */
export const DEFAULT_MODEL: ModelAlias = 'sonnet'

export const MODEL_META_KEY = 'claude.model'

export function isModelAlias(value: unknown): value is ModelAlias {
    return typeof value === 'string' && (MODEL_ALIASES as readonly string[]).includes(value)
}

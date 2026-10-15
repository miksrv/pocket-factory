import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'

import YAML from 'yaml'

import { BadName, NotFound } from './catalog.js'

/**
 * Model providers besides the subscription — `<config>/providers.yaml`, one
 * entry per endpoint: a self-hosted model (Ollama, llama.cpp, vLLM on any
 * machine) or a cloud API (OpenRouter, Gemini, OpenAI, Groq …). A provider is
 * chosen per task (a schedule, a chat, an agent that a task runs as); the
 * `claude` CLI then talks to it instead of Anthropic, through the factory's
 * gateway, which holds the key. A `kind: anthropic` endpoint speaks the
 * Messages API itself (`/v1/messages`); a `kind: openai` one speaks the chat
 * completions API and the gateway translates. Keys are never in this file:
 * `token` names the variable in `.env`.
 */
/**
 * An MCP server that comes with a provider (a search next to a self-hosted model): offered only to
 * the tasks on that provider, through the gateway, which adds the key. Streamable HTTP only.
 */
export interface ProviderMcp {
    /** The server's name in the session: its tools are `mcp__<name>__<tool>`. */
    name: string
    /** The endpoint, e.g. `https://203.0.113.10:8443/mcp`. */
    url: string
    /** Name of the environment variable with its bearer; empty for a server without one. */
    token?: string
}

export interface Provider {
    name: string
    kind: 'anthropic' | 'openai'
    /** Base URL up to (not including) `/v1/messages` or `/chat/completions`, e.g. `http://10.77.0.1:11434` or `https://api.openai.com/v1`. */
    url: string
    /** Name of the environment variable that holds the API key; empty for a local server without one. */
    token?: string
    /** Model ids the owner may pick from (the form offers them; any id can still be typed). */
    models: string[]
    /** The model a task gets when nothing names one. */
    default?: string
    /** The model the CLI's own small calls (the haiku tier) go to; defaults to the task's model. */
    small?: string
    /** Tasks running on this provider at once; 0 = no limit (cloud). A self-hosted GPU serves one. */
    concurrency: number
    /** Light mode: a short system prompt and few tools instead of Claude Code's full prompt (small models need it). */
    light: boolean
    /** MCP servers for the tasks on this provider only (a subscription task never connects to them). */
    mcp?: ProviderMcp[]
}

/** The certificate a provider's TLS is checked against (a self-signed box: its own CA), as the API shows it. */
export interface ProviderCa {
    subject: string
    issuer: string
    /** SHA-256, colon-separated, as browsers and `openssl x509 -fingerprint -sha256` print it. */
    fingerprint: string
    valid_to: string
}

/** A provider as the API shows it: plus whether its key is set and how many tasks run on it now. */
export interface ProviderView extends Omit<Provider, 'mcp'> {
    mcp?: Array<ProviderMcp & { token_set: boolean }>
    /** The CA certificate the factory trusts for it; null = the public ones only. */
    ca: ProviderCa | null
    token_set: boolean
    running: number
}

export interface ProvidersOverview {
    file: string
    providers: ProviderView[]
    /** The file on disk is not valid YAML; saving would replace it. */
    error: string | null
}

/** The built-in provider: the owner's Claude subscription through the CLI's own login. */
export const CLAUDE_PROVIDER = 'claude'

/** Provider names are keys in files (`provider:`) and URL segments: letters, digits, dot, dash, underscore. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** An MCP server's name: becomes part of tool names, so no spaces or colons. */
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
/** An environment variable name. */
export const TOKEN_VAR = /^[A-Z][A-Z0-9_]{0,63}$/
/**
 * Variables a provider may never name as its key: the supervisor's own secrets and the
 * subscription's. `POST /api/providers/test` sends the named variable's value to the URL of the
 * body, so without this list one request from a prompt-injected Bash call would mail the bot
 * token or the UI password anywhere.
 */
const FORBIDDEN_TOKEN_VARS = /^(TELEGRAM_|WEB_|GROQ_|CLAUDE_|ANTHROPIC_|GH_TOKEN|GITHUB_TOKEN|TRAC_|AWS_|DOCKER_)/
/** A key variable must look like one: `…_API_KEY`, `…_KEY`, `…_TOKEN`, `…_SECRET`. */
const TOKEN_SHAPE = /(_API_KEY|_KEY|_TOKEN|_SECRET)$/

/** Why `name` may not be a provider's key variable, or null when it may. */
export function tokenVarProblem(name: string): string | null {
    if (!TOKEN_VAR.test(name))
        return 'token must be the NAME of an environment variable (e.g. GEMINI_API_KEY), not the key'
    if (FORBIDDEN_TOKEN_VARS.test(name)) return `${name} belongs to the factory itself and cannot be a provider's key`
    if (!TOKEN_SHAPE.test(name)) return `${name}: a key variable ends with _API_KEY, _KEY, _TOKEN or _SECRET`
    return null
}
const KINDS = ['anthropic', 'openai'] as const

const HEADER = `# Model providers besides the Claude subscription (edited in Settings → Providers, or by hand).
# \`kind: anthropic\` speaks /v1/messages itself (Ollama, llama.cpp, vLLM, OpenRouter); \`kind: openai\`
# speaks chat completions (OpenAI, Gemini, Groq, LM Studio) and the factory translates. \`token\` is the
# name of the variable in .env that holds the key, never the key itself.
`

/**
 * `provider:model` → both parts; a bare alias or model id is the subscription's.
 * Ollama model ids carry a colon themselves (`qwen3.5:9b`), so the split is at the
 * first one: `lookatstars:qwen3.5:9b`.
 */
export function parseModelRef(ref: string | null | undefined): { provider: string | null; model: string | null } {
    const text = (ref ?? '').trim()
    if (!text || text === CLAUDE_PROVIDER) return { provider: null, model: null }
    const colon = text.indexOf(':')
    if (colon < 0) return { provider: null, model: text }
    const provider = text.slice(0, colon).trim()
    const model = text.slice(colon + 1).trim()
    if (provider === CLAUDE_PROVIDER) return { provider: null, model: model || null }
    return { provider: provider || null, model: model || null }
}

/** The one string form the files and Telegram use: `provider:model`, or the alias alone for the subscription. */
export function modelRef(provider: string | null, model: string | null): string | null {
    if (!provider) return model
    return model ? `${provider}:${model}` : provider
}

/** A failed fetch in words, with what to do when it is the certificate of a self-signed box. */
export function fetchError(error: unknown): string {
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause
    const code = cause?.code ?? ''
    if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code))
        return `${code}: the server's certificate is not trusted; paste its CA certificate into the provider's TLS certificate field and save`
    return cause?.message
        ? `${(error as Error).message}: ${cause.message}`
        : error instanceof Error
          ? error.message
          : String(error)
}

/** The CA store the supervisor started with (bundled + `NODE_EXTRA_CA_CERTS`), before any provider's certificate. */
const BASE_CAS = tls.getCACertificates('default')

/**
 * A pasted PEM → the one CA certificate in it, or `BadName` with the reason. A private key is
 * refused outright (it must never leave the box it belongs to).
 */
export function parseCa(pem: string): { pem: string; info: ProviderCa } {
    if (/PRIVATE KEY/.test(pem)) throw new BadName('that is a private key: paste the CA certificate, never a key')
    const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0]
    if (!block) throw new BadName('paste a certificate in PEM form (-----BEGIN CERTIFICATE----- …)')
    let cert: X509Certificate
    try {
        cert = new X509Certificate(block)
    } catch (error) {
        throw new BadName(`not a valid certificate: ${(error as Error).message}`)
    }
    if (!cert.ca)
        throw new BadName(
            "that is a server's own certificate, which a self-signed box renews often: paste its CA (for Caddy: the root, pki/authorities/local/root.crt)"
        )
    return { pem: block + '\n', info: caInfo(cert) }
}

function caInfo(cert: X509Certificate): ProviderCa {
    return {
        subject: cert.subject.replace(/\n/g, ', '),
        issuer: cert.issuer.replace(/\n/g, ', '),
        fingerprint: cert.fingerprint256,
        valid_to: new Date(cert.validTo).toISOString()
    }
}

export class Providers {
    /** `<config>/certs`: one `<provider>.pem` per provider with its own CA. */
    private readonly certs: string

    constructor(private readonly file: string) {
        this.certs = path.join(path.dirname(file), 'certs')
        this.applyTrust()
    }

    private caFile(name: string): string {
        return path.join(this.certs, `${name}.pem`)
    }

    /** The CA certificate a provider is trusted with, or null. */
    ca(name: string): ProviderCa | null {
        try {
            return caInfo(new X509Certificate(fs.readFileSync(this.caFile(name))))
        } catch {
            return null
        }
    }

    /**
     * Every TLS connection of the supervisor (the gateway, the probes) trusts the public CAs plus
     * the certificates of the providers in the file: a self-signed box works without
     * `NODE_EXTRA_CA_CERTS` or a restart. A certificate of a provider that is gone is not trusted.
     */
    private applyTrust(): void {
        const extra = this.read().providers.flatMap((p) => {
            try {
                return [fs.readFileSync(this.caFile(p.name), 'utf8')]
            } catch {
                return []
            }
        })
        tls.setDefaultCACertificates([...BASE_CAS, ...extra])
    }

    private read(): { providers: Provider[]; error: string | null } {
        if (!fs.existsSync(this.file)) return { providers: [], error: null }
        try {
            const doc = YAML.parse(fs.readFileSync(this.file, 'utf8')) as { providers?: unknown } | null
            const raw = Array.isArray(doc?.providers) ? doc.providers : []
            const providers = raw
                .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
                .filter((p) => typeof p.name === 'string' && typeof p.url === 'string')
                .map((p) => normalize(p))
            return { providers, error: null }
        } catch (error) {
            return { providers: [], error: (error as Error).message }
        }
    }

    private write(providers: Provider[]): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const sorted = [...providers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        fs.writeFileSync(this.file, HEADER + YAML.stringify({ providers: sorted.map(clean) }, { lineWidth: 0 }))
    }

    /** Every provider, as written (invalid file = none). */
    all(): Provider[] {
        return this.read().providers
    }

    get(name: string): Provider | undefined {
        return this.read().providers.find((p) => p.name === name)
    }

    /** The key of a provider, from the environment; null when it names no variable or the variable is empty. */
    key(provider: Provider, env: NodeJS.ProcessEnv = process.env): string | null {
        if (!provider.token) return null
        return env[provider.token]?.trim() || null
    }

    /** The bearer of a provider's MCP server, from the environment; null when it names none or the variable is empty. */
    mcpKey(server: ProviderMcp, env: NodeJS.ProcessEnv = process.env): string | null {
        if (!server.token) return null
        return env[server.token]?.trim() || null
    }

    /** Variable names every provider's keys live in (model and MCP): what the CLI's environment must not carry. */
    tokenVars(): string[] {
        return this.read().providers.flatMap((p) => [
            ...(p.token ? [p.token] : []),
            ...(p.mcp ?? []).flatMap((m) => (m.token ? [m.token] : []))
        ])
    }

    list(running: (name: string) => number = () => 0, env: NodeJS.ProcessEnv = process.env): ProvidersOverview {
        const { providers, error } = this.read()
        return {
            file: this.file,
            providers: providers.map((p) => ({
                ...p,
                ca: this.ca(p.name),
                mcp: p.mcp?.map((m) => ({ ...m, token_set: !m.token || this.mcpKey(m, env) !== null })),
                token_set: this.key(p, env) !== null,
                running: running(p.name)
            })),
            error
        }
    }

    /** Create or update a provider; a different `name` in the body renames it (files that refer to the old name are the owner's to fix). */
    save(name: string, input: Partial<Provider> & { name?: string; ca?: string | null }): Provider {
        const target = input.name?.trim() || name
        for (const n of [name, target]) {
            if (!NAME.test(n))
                throw new BadName(`Invalid provider name "${n}": use letters, digits, dot, dash, underscore`)
            if (n === CLAUDE_PROVIDER)
                throw new BadName(`"${CLAUDE_PROVIDER}" is the subscription itself; pick another name`)
        }
        const next = validate({ ...input, name: target })
        const { providers, error } = this.read()
        if (error) throw new Error(`providers.yaml is not valid YAML (${error}); fix the file by hand first`)
        const index = providers.findIndex((p) => p.name === name)
        if (target !== name && providers.some((p) => p.name === target))
            throw new BadName(`a provider named "${target}" already exists`)
        // `ca`: a PEM replaces the certificate, '' or null removes it, absent keeps it (a rename takes it along).
        const ca = typeof input.ca === 'string' && input.ca.trim() ? parseCa(input.ca) : null
        if (index >= 0) providers[index] = next
        else providers.push(next)
        this.write(providers)
        fs.mkdirSync(this.certs, { recursive: true })
        if (target !== name && fs.existsSync(this.caFile(name))) fs.renameSync(this.caFile(name), this.caFile(target))
        if (ca) fs.writeFileSync(this.caFile(target), ca.pem)
        else if (input.ca !== undefined) fs.rmSync(this.caFile(target), { force: true })
        this.applyTrust()
        return next
    }

    remove(name: string): void {
        const { providers, error } = this.read()
        if (error) throw new Error(`providers.yaml is not valid YAML (${error}); fix the file by hand first`)
        if (!providers.some((p) => p.name === name)) throw new NotFound(`provider "${name}" not found`)
        this.write(providers.filter((p) => p.name !== name))
        fs.rmSync(this.caFile(name), { force: true })
        this.applyTrust()
    }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const list = (v: unknown): string[] =>
    Array.isArray(v)
        ? v.flatMap((m) => (typeof m === 'string' && m.trim() ? [m.trim()] : []))
        : typeof v === 'string'
          ? v
                .split(/[,\n]/)
                .map((m) => m.trim())
                .filter(Boolean)
          : []

/** A file entry as read: lenient, so one bad field does not hide the provider. */
function normalize(p: Record<string, unknown>): Provider {
    const kind = str(p.kind)
    const models = list(p.models)
    const concurrency = typeof p.concurrency === 'number' ? p.concurrency : Number(str(p.concurrency) ?? NaN)
    return clean({
        name: String(p.name),
        kind: kind === 'openai' ? 'openai' : 'anthropic',
        url: String(p.url).trim().replace(/\/+$/, ''),
        token: str(p.token),
        models,
        default: str(p.default),
        small: str(p.small),
        concurrency: Number.isFinite(concurrency) && concurrency >= 0 ? Math.floor(concurrency) : 1,
        light: typeof p.light === 'boolean' ? p.light : true,
        mcp: mcpList(p.mcp, false)
    })
}

/**
 * `mcp:` of a provider. Read leniently (an entry without a name or an http(s) URL is skipped) or,
 * for a save, strictly (`BadName` with the reason).
 */
export function mcpList(raw: unknown, strict: boolean): ProviderMcp[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const servers: ProviderMcp[] = []
    for (const item of raw as unknown[]) {
        const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
        const name = str(entry.name)
        const url = str(entry.url)
        const token = str(entry.token)
        if (!name && !url && !token) continue
        const problem =
            !name || !MCP_NAME.test(name)
                ? `MCP server name "${name ?? ''}": letters, digits, dash, underscore`
                : !url || !/^https?:\/\/[^\s/]+/.test(url)
                  ? `MCP server ${name}: url must start with http:// or https://`
                  : servers.some((s) => s.name === name)
                    ? `MCP server ${name} is listed twice`
                    : token
                      ? tokenVarProblem(token)
                      : null
        if (problem) {
            if (strict) throw new BadName(problem)
            continue
        }
        servers.push(clean({ name: name!, url: url!, token }))
    }
    return servers.length ? servers : undefined
}

/** What a save must satisfy; throws `BadName` with the reason. */
function validate(input: Partial<Provider> & { name: string }): Provider {
    const kind = str(input.kind) ?? 'anthropic'
    if (!(KINDS as readonly string[]).includes(kind)) throw new BadName(`kind must be one of ${KINDS.join(', ')}`)
    const url = str(input.url)?.replace(/\/+$/, '')
    if (!url || !/^https?:\/\/[^\s/]+/.test(url)) throw new BadName('url must start with http:// or https://')
    const token = str(input.token)
    const problem = token ? tokenVarProblem(token) : null
    if (problem) throw new BadName(problem)
    const models = list(input.models)
    if (!models.length) throw new BadName('at least one model id is required')
    if (models.some((m) => /\s/.test(m))) throw new BadName('model ids must not contain spaces')
    const fallback = str(input.default)
    const small = str(input.small)
    const concurrency =
        input.concurrency === undefined || input.concurrency === null
            ? 1
            : typeof input.concurrency === 'number'
              ? input.concurrency
              : Number(str(input.concurrency) ?? NaN)
    if (!Number.isFinite(concurrency) || concurrency < 0 || concurrency > 64)
        throw new BadName('concurrency must be a number from 0 (no limit) to 64')
    return clean({
        name: input.name,
        kind: kind as Provider['kind'],
        url,
        token,
        models,
        default: fallback && models.includes(fallback) ? fallback : undefined,
        small,
        concurrency: Math.floor(concurrency),
        light: input.light !== false,
        mcp: mcpList(input.mcp, true)
    })
}

/** Drop empty optional fields so the YAML stays as short as the owner wrote it. */
function clean<T extends object>(obj: T): T {
    return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== '')
    ) as T
}

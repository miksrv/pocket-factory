import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
    api,
    type DockerContainer,
    fmt,
    type ProjectToolchain,
    type ToolchainsOverview,
    type ToolVersion
} from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Field } from './Editor'
import { useConfirm } from './Modal'
import { Button, useToast } from './ui'

/**
 * What the agents build and test with. Settings → Toolchains lists the
 * versions mise installed (with their size and the projects on them), the
 * image's PHP, and the dind sidecar's containers; the project form shows a
 * checkout's needs with a badge each and an Install button for a missing one.
 */

const kb = (n: number | null) => (n === null ? '?' : fmt.bytes(n * 1024))

export function ToolchainsSection({
    data,
    error,
    onChanged
}: {
    data: ToolchainsOverview | undefined
    error?: string
    onChanged: () => void
}) {
    const [toast, showToast] = useToast()
    const confirm = useConfirm()
    const [busy, setBusy] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const [spec, setSpec] = useState('')
    if (!data) return error ? <div className='error small'>{error}</div> : <div className='dim small'>…</div>

    const act = async (what: string, run: () => Promise<string>) => {
        setBusy(what)
        setFailed(null)
        try {
            showToast(await run())
            onChanged()
        } catch (e) {
            setFailed((e as Error).message)
        } finally {
            setBusy(null)
        }
    }
    const install = () => {
        const s = spec.trim()
        if (!s) return
        void act(`install ${s}`, async () => {
            await api.installTool(s)
            setSpec('')
            return `Installed ${s}`
        })
    }
    const remove = (t: ToolVersion) =>
        void confirm({
            title: `Remove ${t.tool} ${t.version}?`,
            message: t.used_by.length
                ? `${t.used_by.join(', ')} resolve to it; their next task installs it again.`
                : 'No project resolves to this version now.',
            action: 'Remove',
            danger: true,
            onConfirm: () =>
                act(`remove ${t.tool}@${t.version}`, async () => {
                    await api.removeTool(t.tool, t.version)
                    return `Removed ${t.tool} ${t.version}`
                })
        })
    const prune = () =>
        void confirm({
            title: 'Prune toolchains?',
            message:
                'Removes the versions no checkout asks for any more and, with Docker on, its stopped containers, dangling images and build cache.',
            action: 'Prune',
            danger: true,
            onConfirm: () =>
                act('prune', async () => {
                    const r = await api.pruneToolchains()
                    return r.docker ? `Pruned · Docker reclaimed ${r.docker}` : 'Pruned'
                })
        })
    const stop = (c: DockerContainer) =>
        void act(`stop ${c.id}`, async () => {
            await api.stopContainer(c.id)
            return `Stopped ${c.name}`
        })

    const docker = data.docker
    const running = docker.containers.filter((c) => c.state === 'running')
    const stopped = docker.containers.length - running.length
    return (
        <div className='stack'>
            {error && <div className='error small'>{error}</div>}
            <div className='kv'>
                <span>Runtimes</span>
                <span>
                    {data.mise.version ? (
                        <>
                            mise {data.mise.version.split(' ')[0]} · {fmt.plural(data.mise.tools.length, 'version')} in{' '}
                            <code>{data.mise.data_dir}</code> · {kb(data.mise.size_kb)}
                            {data.mise.error && <span className='error'> · {data.mise.error}</span>}
                        </>
                    ) : (
                        <span className='error'>
                            {data.mise.data_dir
                                ? 'mise is not on PATH here — the agents cannot install runtimes'
                                : 'no factory mise outside the container (yarn dev): the agents install nothing here'}
                        </span>
                    )}
                </span>
            </div>
            <div className='kv'>
                <span>In the image</span>
                <span>
                    {data.image.php ? `PHP ${data.image.php}` : 'no PHP'}
                    {data.image.composer ? ` · composer ${data.image.composer.split(' ')[0]}` : ''}
                    <span className='dim'> · set with the image, not here</span>
                </span>
            </div>
            {data.mise.version && (
                <div className='tc-list'>
                    {data.mise.tools.length === 0 && (
                        <div className='dim small'>
                            Nothing installed yet: the first task that needs a runtime installs it.
                        </div>
                    )}
                    {data.mise.tools.map((t) => (
                        <div
                            key={`${t.tool}@${t.version}`}
                            className='mcp-row'
                        >
                            <span className='grow'>
                                <strong>
                                    {t.tool} {t.version}
                                </strong>{' '}
                                <span className='dim small'>
                                    · {kb(t.size_kb)}
                                    {t.used_by.length
                                        ? ` · ${t.used_by.join(', ')}`
                                        : t.asked_by
                                          ? ` · asked by ${t.asked_by}`
                                          : ' · no project resolves to it'}
                                </span>
                            </span>
                            <Button
                                size='sm'
                                variant='ghost'
                                disabled={busy !== null}
                                onClick={() => remove(t)}
                            >
                                Remove
                            </Button>
                        </div>
                    ))}
                </div>
            )}
            {data.mise.version && (
                <div className='controls'>
                    <input
                        className='mono'
                        placeholder='go@1.25.1, node@20, python@3.12…'
                        value={spec}
                        aria-label='Tool to install'
                        onChange={(e) => setSpec(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') install()
                        }}
                    />
                    <Button
                        disabled={busy !== null || !spec.trim()}
                        onClick={install}
                        title='mise install; a Go or Python download takes a minute or two'
                    >
                        {busy?.startsWith('install') ? 'Installing…' : 'Install'}
                    </Button>
                    <Button
                        variant='ghost'
                        disabled={busy !== null}
                        onClick={prune}
                        title='mise prune (+ docker system prune with Docker on)'
                    >
                        {busy === 'prune' ? 'Pruning…' : 'Prune'}
                    </Button>
                </div>
            )}
            <div className='kv'>
                <span>Docker</span>
                <span>
                    {!docker.enabled ? (
                        <>
                            off — the agents have no Docker.{' '}
                            <span className='dim'>COMPOSE_PROFILES=docker in .env, then docker compose up -d</span>
                        </>
                    ) : docker.reachable ? (
                        <>
                            dind {docker.version} at <code>{docker.host}</code> ·{' '}
                            {fmt.plural(running.length, 'container')} running{stopped ? `, ${stopped} stopped` : ''}
                            {docker.disk.length
                                ? ` · ${docker.disk.map((d) => `${d.type.toLowerCase()} ${d.size}`).join(', ')}`
                                : ''}
                        </>
                    ) : (
                        <span className='error'>
                            {docker.host} does not answer{docker.error ? `: ${docker.error}` : ''} — is the sidecar up?
                        </span>
                    )}
                </span>
            </div>
            {docker.containers.length > 0 && (
                <div className='tc-list'>
                    {docker.containers.map((c) => (
                        <div
                            key={c.id}
                            className='mcp-row'
                        >
                            <span className={`live${c.state === 'running' ? '' : ' off'}`} />
                            <span className='grow'>
                                <strong>{c.name}</strong>{' '}
                                <span className='dim small'>
                                    · {c.image} · {c.status}
                                    {(c.project ?? c.compose.project) ? ` · ${c.project ?? c.compose.project}` : ''}
                                    {c.ports ? ` · ${c.ports}` : ''}
                                </span>
                            </span>
                            {c.state === 'running' && (
                                <Button
                                    size='sm'
                                    variant='ghost'
                                    disabled={busy !== null}
                                    onClick={() => stop(c)}
                                >
                                    Stop
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {failed && <div className='error small'>{failed}</div>}
            {toast}
        </div>
    )
}

const TONE: Record<ProjectToolchain['tools'][number]['status'], string> = {
    installed: 'done',
    image: 'done',
    missing: 'queued',
    unknown: 'cancelled'
}

/** The project form's block: what the checkout needs, what the factory has, Install for the rest. */
export function ProjectToolchainField({ slug }: { slug: string }) {
    const needs = useAsync(() => (slug ? api.projectToolchain(slug) : Promise.resolve(null)), [slug])
    const [busy, setBusy] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    if (!slug) return null
    const d = needs.data
    const install = async (spec: string) => {
        setBusy(spec)
        setFailed(null)
        try {
            await api.installTool(spec)
            needs.reload()
        } catch (e) {
            setFailed((e as Error).message)
        } finally {
            setBusy(null)
        }
    }
    return (
        <Field
            label='Toolchain'
            hint={
                d && !d.tools.length && !d.services.length
                    ? 'Nothing recognised in the checkout (go.mod, .nvmrc, package.json, composer.json, .python-version, a compose file). The agent still has mise and PHP.'
                    : 'Read from the checkout. The agent installs a missing runtime itself before the checks (mise install); Install here does it now. Services come from the compose file, started by the agent on the factory’s Docker and stopped when its task ends.'
            }
            wide
            group
        >
            {needs.error ? (
                <span className='error small'>{needs.error}</span>
            ) : !d ? (
                <span className='dim small'>…</span>
            ) : (
                <div className='mcp-servers'>
                    {d.tools.map((t) => (
                        <div
                            key={t.tool}
                            className='mcp-server row'
                            title={t.source}
                        >
                            <span className='grow'>
                                <strong>{t.tool}</strong>{' '}
                                <span className='dim'>
                                    · {t.version ?? 'any version'} · {t.source}
                                    {t.status === 'installed' &&
                                    t.installed_version &&
                                    t.installed_version !== t.version
                                        ? ` · ${t.installed_version} in use`
                                        : ''}
                                </span>
                            </span>
                            <span className={`badge ${TONE[t.status]}`}>
                                {t.status === 'image'
                                    ? `in the image (${t.installed_version})`
                                    : t.status === 'unknown'
                                      ? 'mise not available'
                                      : t.status}
                            </span>
                            {t.status === 'missing' && (
                                <Button
                                    size='sm'
                                    disabled={busy !== null}
                                    onClick={() => void install(t.spec)}
                                    title={`mise install ${t.spec}`}
                                >
                                    {busy === t.spec ? 'Installing…' : `Install ${t.spec}`}
                                </Button>
                            )}
                        </div>
                    ))}
                    {d.services.map((s) => (
                        <div
                            key={s.file}
                            className='mcp-server row'
                        >
                            <span className='grow'>
                                <strong>services</strong>{' '}
                                <span className='dim'>
                                    · {s.services.length ? s.services.join(', ') : 'none readable'} · {s.file}
                                </span>
                            </span>
                            <span
                                className={`badge ${d.docker.enabled ? 'done' : 'queued'}`}
                                title={
                                    d.docker.enabled
                                        ? 'The agent starts them on the factory’s Docker'
                                        : 'COMPOSE_PROFILES=docker in .env switches the sidecar on'
                                }
                            >
                                {d.docker.enabled ? 'docker on' : 'docker off'}
                            </span>
                        </div>
                    ))}
                    {failed && <div className='error small'>{failed}</div>}
                    <div className='dim small'>
                        Every installed version, sizes and the containers:{' '}
                        <Link to='/settings#toolchains'>Settings → Toolchains</Link>
                    </div>
                </div>
            )}
        </Field>
    )
}

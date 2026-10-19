import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
    api,
    fmt,
    type Preview,
    type ProjectSandbox,
    type SandboxApproval,
    type SandboxesOverview,
    type SandboxView
} from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { Icon } from './Icon'
import { useConfirm } from './Modal'
import { Button, Empty, ErrorBox, Stat, useToast } from './ui'

/**
 * Where the agents run. Settings → Sandboxes shows the Docker Sandboxes daemon, the two logins it
 * needs (Docker account, Claude), the factory's `pf-*` sandboxes with Stop and Reset, the requests
 * their network policy held back and the open previews; a project's page shows its own sandbox,
 * preview and blocked requests above the form.
 */

const RESET_MESSAGE =
    'Reset removes everything installed in the sandbox (packages, runtimes, Docker images and containers); the checkout and the factory’s files are not touched. The next task makes a fresh one.'

/** `pf-shop` → "shop"; the factory's own sandbox is named after what it serves. */
const label = (s: { project: string | null; name: string }) =>
    s.project ?? (s.name === 'pf-factory' ? 'chats without a project' : s.name)

function useActions(onChanged: () => void) {
    const [busy, setBusy] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const [toast, showToast] = useToast()
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
    return { busy, failed, toast, act }
}

/** One request a sandbox's policy refused, with Allow / Deny. */
function ApprovalRow({
    approval,
    busy,
    onAnswer
}: {
    approval: SandboxApproval
    busy: boolean
    onAnswer: (allow: boolean) => void
}) {
    return (
        <div className='mcp-row'>
            <span className='live warn' />
            <span className='grow'>
                <strong className='mono'>{approval.resource}</strong>{' '}
                <span className='dim small'>
                    · {approval.project ? `project ${approval.project}` : 'chats without a project'} ·{' '}
                    {fmt.ago(approval.seen_at)}
                </span>
            </span>
            <Button
                size='sm'
                disabled={busy}
                onClick={() => onAnswer(true)}
                title={
                    approval.project
                        ? `Adds ${approval.resource} to the network: list of ${approval.project}`
                        : 'Allows it for the factory’s own sandbox'
                }
            >
                Allow
            </Button>
            <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => onAnswer(false)}
            >
                Deny
            </Button>
        </div>
    )
}

/** The open preview of a project: its address, the port, since when, Open and Stop. */
function PreviewRow({ preview, busy, onStop }: { preview: Preview; busy: boolean; onStop: () => void }) {
    return (
        <div className='mcp-row'>
            <span className='live' />
            <span className='grow'>
                <strong>{preview.project}</strong>{' '}
                <span className='dim small'>
                    · port {preview.port}
                    {preview.host_port !== preview.port ? ` (host ${preview.host_port})` : ''} · since{' '}
                    {fmt.ago(preview.created_at)}
                    {preview.expires_at ? ` · ends in ${fmt.until(preview.expires_at)}` : ''}
                </span>
            </span>
            <Button
                size='sm'
                variant='ghost'
                href={preview.url}
                title={preview.url}
            >
                <Icon
                    name='external'
                    size={13}
                />
                Open
            </Button>
            <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={onStop}
            >
                Stop
            </Button>
        </div>
    )
}

export function SandboxesSection() {
    const data = useAsync(() => api.sandboxes(), [], 15_000)
    const confirm = useConfirm()
    const { busy, failed, toast, act } = useActions(data.reload)
    const d = data.data
    if (!d)
        return data.error ? (
            <ErrorBox
                error={data.error}
                inline
            />
        ) : (
            <Empty inline>…</Empty>
        )
    if (d.mode === 'local')
        return (
            <div className='stack'>
                <div className='kv'>
                    <span>Mode</span>
                    <span>
                        on this machine (<code>SANDBOX=local</code>): the agents run in the supervisor’s own
                        environment, with whatever it has installed
                    </span>
                </div>
                <Previews
                    previews={d.previews}
                    busy={busy}
                    act={act}
                />
                <ErrorBox
                    error={failed}
                    inline
                />
                {toast}
            </div>
        )

    const stop = (s: SandboxView) =>
        void act(`stop ${s.name}`, async () => {
            await api.stopSandbox(s.name)
            return `Stopped ${s.name}`
        })
    const reset = (s: SandboxView) =>
        void confirm({
            title: `Reset ${s.name}?`,
            message: RESET_MESSAGE,
            action: 'Reset',
            pending: 'Removing…',
            danger: true,
            onConfirm: async () => {
                await api.resetSandbox(s.name)
                data.reload()
            }
        })
    const answer = (a: SandboxApproval, allow: boolean) =>
        void act(`approval ${a.id}`, async () => {
            await api.answerApproval(a.id, allow)
            return allow ? `Allowed ${a.resource}` : `${a.resource} stays blocked`
        })
    const refresh = () =>
        void act('refresh', async () => {
            await api.refreshSandboxes()
            return 'Checked'
        })
    const yesNo = (value: boolean | null, yes: string, no: string, unknown: string) =>
        value === null ? <span className='dim'>{unknown}</span> : value ? yes : <span className='error'>{no}</span>

    return (
        <div className='stack'>
            <div className='kv'>
                <span>Daemon</span>
                <span>
                    {d.ok === false ? (
                        <span className='error'>does not answer: {d.error}</span>
                    ) : d.ok ? (
                        `sbx ${d.version ?? '?'} · ${fmt.plural(d.sandboxes.filter((s) => s.status === 'running').length, 'sandbox')} running of ${d.sandboxes.length}`
                    ) : (
                        <span className='dim'>checking…</span>
                    )}
                </span>
            </div>
            <div className='kv'>
                <span>Docker account</span>
                <span>
                    {yesNo(d.docker_login, 'signed in', 'not signed in — ssh to the server, run sbx login', 'unknown')}
                </span>
            </div>
            <div className='kv'>
                <span>Claude login</span>
                <span>
                    {yesNo(
                        d.claude_login,
                        'held by the sandboxes’ proxy (connectors included)',
                        'missing — ssh -t to the server, sbx run pf-factory, then /login (press c to copy the URL)',
                        'unknown'
                    )}
                </span>
            </div>
            <div className='tc-list'>
                {d.sandboxes.length === 0 && (
                    <div className='dim small'>No sandbox yet: a project’s first task makes its own.</div>
                )}
                {d.sandboxes.map((s) => (
                    <div
                        key={s.name}
                        className='mcp-row'
                    >
                        <span className={`live${s.status === 'running' ? '' : ' off'}`} />
                        <span className='grow'>
                            <strong>{label(s)}</strong>{' '}
                            <span className='dim small'>
                                · {s.name} · {s.status}
                                {s.active ? ` · ${fmt.plural(s.active, 'run')} now` : ''}
                                {s.last_used_at ? ` · used ${fmt.ago(s.last_used_at)}` : ''}
                                {s.pinned ? ' · preview open' : ''}
                            </span>
                        </span>
                        {s.status === 'running' && (
                            <Button
                                size='sm'
                                variant='ghost'
                                disabled={busy !== null || s.active > 0}
                                onClick={() => stop(s)}
                                title='Stops the VM; everything installed stays'
                            >
                                Stop
                            </Button>
                        )}
                        <Button
                            size='sm'
                            variant='ghost'
                            disabled={busy !== null || s.active > 0}
                            onClick={() => reset(s)}
                        >
                            Reset
                        </Button>
                    </div>
                ))}
            </div>
            {d.approvals.length > 0 && (
                <div className='tc-list'>
                    <div className='dim small'>Blocked by the network policy, waiting for you:</div>
                    {d.approvals.map((a) => (
                        <ApprovalRow
                            key={a.id}
                            approval={a}
                            busy={busy !== null}
                            onAnswer={(allow) => answer(a, allow)}
                        />
                    ))}
                </div>
            )}
            <Previews
                previews={d.previews}
                busy={busy}
                act={act}
            />
            <div className='controls'>
                <Button
                    variant='ghost'
                    disabled={busy !== null}
                    onClick={refresh}
                >
                    {busy === 'refresh' ? 'Checking…' : 'Check now'}
                </Button>
            </div>
            <ErrorBox
                error={failed}
                inline
            />
            {toast}
        </div>
    )
}

function Previews({
    previews,
    busy,
    act
}: {
    previews: SandboxesOverview['previews']
    busy: string | null
    act: (what: string, run: () => Promise<string>) => Promise<void>
}) {
    if (!previews.length) return null
    return (
        <div className='tc-list'>
            <div className='dim small'>Previews:</div>
            {previews.map((p) => (
                <PreviewRow
                    key={p.project}
                    preview={p}
                    busy={busy !== null}
                    onStop={() =>
                        void act(`preview ${p.project}`, async () => {
                            await api.stopPreview(p.project)
                            return `Stopped the preview of ${p.project}`
                        })
                    }
                />
            ))}
        </div>
    )
}

/** The project page's card above the form: its sandbox, its preview and what its policy held back. */
export function ProjectSandboxCard({ slug }: { slug: string }) {
    const data = useAsync(() => api.projectSandbox(slug), [slug], 10_000)
    const confirm = useConfirm()
    const { busy, failed, toast, act } = useActions(data.reload)
    const d: ProjectSandbox | undefined = data.data
    if (!d)
        return data.error ? (
            <ErrorBox
                error={data.error}
                inline
            />
        ) : null
    // Without sandboxes the card has nothing to say but an open preview.
    if (d.mode === 'local' && !d.preview) return null
    const s = d.sandbox
    const reset = () =>
        void confirm({
            title: `Reset ${d.name}?`,
            message: RESET_MESSAGE,
            action: 'Reset',
            pending: 'Removing…',
            danger: true,
            onConfirm: async () => {
                await api.resetSandbox(d.name)
                data.reload()
            }
        })
    return (
        <div className='card pad0 routine-status'>
            <div className='stat-row'>
                {d.mode === 'sbx' && (
                    <Stat
                        label='Sandbox'
                        value={s ? s.status : 'not made yet'}
                        sub={
                            s
                                ? [
                                      d.name,
                                      s.active ? `${fmt.plural(s.active, 'run')} now` : null,
                                      s.last_used_at ? `used ${fmt.ago(s.last_used_at)}` : null
                                  ]
                                      .filter(Boolean)
                                      .join(' · ')
                                : 'the next task makes it'
                        }
                    />
                )}
                <Stat
                    label='Preview'
                    value={
                        d.preview ? (
                            <a
                                href={d.preview.url}
                                target='_blank'
                                rel='noreferrer'
                            >
                                open
                            </a>
                        ) : (
                            'none'
                        )
                    }
                    sub={
                        d.preview
                            ? `port ${d.preview.port} · since ${fmt.ago(d.preview.created_at)}`
                            : 'ask the agent to show the app'
                    }
                />
            </div>
            {d.approvals.length > 0 && (
                <div className='stack routine-band'>
                    {d.approvals.map((a) => (
                        <ApprovalRow
                            key={a.id}
                            approval={a}
                            busy={busy !== null}
                            onAnswer={(allow) =>
                                void act(`approval ${a.id}`, async () => {
                                    await api.answerApproval(a.id, allow)
                                    return allow ? `Allowed ${a.resource}` : `${a.resource} stays blocked`
                                })
                            }
                        />
                    ))}
                </div>
            )}
            <div className='row wrap routine-actions'>
                {d.preview && (
                    <Button
                        size='sm'
                        variant='ghost'
                        disabled={busy !== null}
                        onClick={() =>
                            void act('preview', async () => {
                                await api.stopPreview(slug)
                                return 'Preview stopped'
                            })
                        }
                    >
                        Stop preview
                    </Button>
                )}
                {d.mode === 'sbx' && s && (
                    <Button
                        size='sm'
                        variant='ghost'
                        disabled={busy !== null || s.active > 0}
                        onClick={reset}
                        title='Removes what the agent installed in it; the checkout stays'
                    >
                        Reset sandbox
                    </Button>
                )}
                <span className='dim small grow'>
                    <Link to='/settings#sandboxes'>Settings → Sandboxes</Link>
                </span>
            </div>
            <ErrorBox
                error={failed}
                inline
            />
            {toast}
        </div>
    )
}

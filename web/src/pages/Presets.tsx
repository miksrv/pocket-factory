import { useState } from 'react'
import { Link } from 'react-router-dom'

import { Modal, useConfirm } from '../components/Modal'
import { Button, Empty, ErrorBox, Markdown, PageHead, useToast } from '../components/ui'
import { api, fmt, type Preset } from '../lib/api'
import { Tile } from '../components/Tile'
import { useAsync } from '../lib/useAsync'

/** "installed · 5 files", "not installed · 5 files" or "2 of 5 files installed" when another preset already brought some. */
function PresetStatus({ preset }: { preset: Preset }) {
    const total = preset.files.length
    const present = preset.files.filter((f) => f.installed).length
    if (preset.installed) {
        return (
            <>
                <span style={{ color: 'var(--green)' }}>installed</span> · {fmt.plural(total, 'file')}
            </>
        )
    }
    if (present === 0) return <>not installed · {fmt.plural(total, 'file')}</>
    return (
        <>
            {present} of {total} files installed
        </>
    )
}

/** The README without its first `# Title` line: the window's own title already says it. */
const readmeBody = (readme: string) => readme.replace(/^\s*# [^\n]*\n+/, '')

export function PresetsPage() {
    const presets = useAsync(() => api.presets(), [])
    // By name, so the window shows the fresh state after an install from it.
    const [openName, setOpenName] = useState<string | null>(null)
    const open = presets.data?.find((p) => p.name === openName) ?? null
    const [toast, showToast] = useToast()
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const confirm = useConfirm()

    const run = async (preset: Preset, overwrite: boolean) => {
        setBusy(preset.name)
        try {
            const { installed } = await api.installPreset(preset.name, overwrite)
            showToast(installed.length ? `Installed ${fmt.plural(installed.length, 'file')}` : 'Nothing to install — already present')
            presets.reload()
        } finally {
            setBusy(null)
        }
    }
    const install = async (preset: Preset) => {
        setError(null)
        try {
            await run(preset, false)
        } catch (e) {
            setError((e as Error).message)
        }
    }
    // Reinstall replaces the owner's copies: the question lists them, and a failure shows in the window.
    const reinstall = (preset: Preset) => {
        const files = preset.files.map((f) => `${f.kind}/${f.name}`)
        void confirm({
            title: `Reinstall “${preset.title}”?`,
            message: (
                <>
                    Your copies of {files.map((f, i) => (
                        <span key={f}>
                            {i > 0 && ', '}
                            <code>{f}</code>
                        </span>
                    ))}{' '}
                    are replaced with the preset versions. Edits made to them are lost.
                </>
            ),
            action: 'Overwrite',
            pending: 'Installing…',
            danger: true,
            icon: 'warning',
            onConfirm: () => run(preset, true)
        })
    }

    const installButton = (preset: Preset, size?: 'sm') =>
        preset.installed ? (
            <Button size={size} onClick={() => reinstall(preset)} disabled={busy === preset.name}>
                {busy === preset.name ? 'Installing…' : 'Reinstall'}
            </Button>
        ) : (
            <Button size={size} variant="primary" onClick={() => install(preset)} disabled={busy === preset.name}>
                {busy === preset.name ? 'Installing…' : 'Install'}
            </Button>
        )

    return (
        <div className="page">
            <PageHead title="Presets" sub="Ready-made bundles of agents, skills and project templates shipped with the repository. Install copies them onto the volume; from then on they are yours to edit." />
            <ErrorBox error={presets.error ?? error} />
            {presets.data?.length === 0 && <Empty>No presets found in presets/.</Empty>}
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {presets.data?.map((preset) => (
                    <div key={preset.name} className="card preset-card">
                        <div className="preset-card-head">
                            <Tile name={preset.name} kind="presets" large />
                            <div className="grow">
                                <div className="agent-name">{preset.title}</div>
                                <div className="dim small">
                                    <PresetStatus preset={preset} />
                                </div>
                            </div>
                        </div>
                        <p className="preset-desc">{preset.description}</p>
                        <div className="row wrap">
                            {preset.tags.map((t) => (
                                <span key={t} className="badge plain">
                                    {t}
                                </span>
                            ))}
                        </div>
                        <div className="preset-files small">
                            {preset.files.map((f) => (
                                <span key={`${f.kind}/${f.name}`}>
                                    <span className="dim">{f.kind}/</span>
                                    {f.installed ? <Link to={`/${f.kind}/${f.name}`}>{f.name}</Link> : f.name}
                                </span>
                            ))}
                        </div>
                        <div className="preset-card-foot">
                            <div className="toolbar">
                                {preset.readme && (
                                    <Button size="sm" onClick={() => setOpenName(preset.name)}>
                                        Details
                                    </Button>
                                )}
                                {installButton(preset, 'sm')}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            {open && (
                <Modal
                    open
                    onClose={() => setOpenName(null)}
                    title={open.title}
                    description={<PresetStatus preset={open} />}
                    icon="presets"
                    size="wide"
                    footer={
                        <>
                            <Button onClick={() => setOpenName(null)}>Close</Button>
                            {installButton(open)}
                        </>
                    }
                    content={<Markdown source={readmeBody(open.readme ?? '')} document />}
                >
                    <ErrorBox error={error ?? undefined} />
                </Modal>
            )}
            {toast}
        </div>
    )
}

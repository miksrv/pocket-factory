import { useState } from 'react'
import { Link } from 'react-router-dom'

import { Button, Empty, ErrorBox, Markdown, PageHead, useToast } from '../components/ui'
import { api, fmt, type Preset } from '../lib/api'
import { Tile } from '../components/Tile'
import { useAsync } from '../lib/useAsync'

export function PresetsPage() {
    const presets = useAsync(() => api.presets(), [])
    const [open, setOpen] = useState<Preset | null>(null)
    const [toast, showToast] = useToast()
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const install = async (preset: Preset, overwrite = false) => {
        if (overwrite && !window.confirm(`Overwrite existing ${preset.files.map((f) => `${f.kind}/${f.name}`).join(', ')} with the preset versions?`)) return
        setBusy(preset.name)
        setError(null)
        try {
            const { installed } = await api.installPreset(preset.name, overwrite)
            showToast(installed.length ? `Installed ${fmt.plural(installed.length, 'file')}` : 'Nothing to install — already present')
            presets.reload()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="page">
            <PageHead title="Presets" sub="Ready-made bundles of agents, skills and project templates shipped with the repository. Install copies them onto the volume; from then on they are yours to edit." />
            <ErrorBox error={presets.error ?? error} />
            {presets.data?.length === 0 && <Empty>No presets found in presets/.</Empty>}
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {presets.data?.map((preset) => (
                    <div key={preset.name} className="card stack">
                        <div className="row between top">
                            <div className="row top">
                                <Tile name={preset.name} kind="presets" />
                                <div>
                                    <div style={{ fontWeight: 600 }}>{preset.title}</div>
                                    <div className="dim small">{preset.description}</div>
                                </div>
                            </div>
                            {preset.installed && <span className="badge done">installed</span>}
                        </div>
                        <div className="row wrap">
                            {preset.tags.map((t) => (
                                <span key={t} className="badge plain">
                                    {t}
                                </span>
                            ))}
                        </div>
                        <div className="small">
                            {preset.files.map((f) => (
                                <div key={`${f.kind}/${f.name}`}>
                                    <span className="dim">{f.kind}/</span>
                                    {preset.installed ? <Link to={`/${f.kind}/${f.name}`}>{f.name}</Link> : f.name}
                                </div>
                            ))}
                        </div>
                        <div className="toolbar">
                            {preset.readme && (
                                <Button size="sm" onClick={() => setOpen(preset)}>
                                    Details
                                </Button>
                            )}
                            {preset.installed ? (
                                <Button size="sm" onClick={() => install(preset, true)} disabled={busy === preset.name}>
                                    {busy === preset.name ? 'Installing…' : 'Reinstall'}
                                </Button>
                            ) : (
                                <Button size="sm" variant="primary" onClick={() => install(preset)} disabled={busy === preset.name}>
                                    {busy === preset.name ? 'Installing…' : 'Install'}
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {open && (
                <div className="card" style={{ marginTop: 16 }}>
                    <div className="row between">
                        <h3 style={{ margin: 0 }}>{open.title}</h3>
                        <Button size="sm" onClick={() => setOpen(null)}>
                            Close
                        </Button>
                    </div>
                    <Markdown source={open.readme ?? ''} document />
                </div>
            )}
            {toast}
        </div>
    )
}

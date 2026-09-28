import { useState } from 'react'
import { Link } from 'react-router-dom'

import { Empty, ErrorBox, PageHead, useToast } from '../components/ui'
import { api, type Preset } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { useAsync } from '../lib/useAsync'

export function PresetsPage() {
    const presets = useAsync(() => api.presets(), [])
    const [open, setOpen] = useState<Preset | null>(null)
    const [toast, showToast] = useToast()

    const install = async (preset: Preset, overwrite = false) => {
        if (overwrite && !confirm(`Overwrite existing ${preset.files.map((f) => `${f.kind}/${f.name}`).join(', ')} with the preset versions?`)) return
        const { installed } = await api.installPreset(preset.name, overwrite)
        showToast(installed.length ? `Installed ${installed.length} file(s)` : 'Nothing to install — already present')
        presets.reload()
    }

    return (
        <div className="page">
            <PageHead title="Presets" sub="Ready-made bundles of agents, skills and project templates shipped with the repository. Install copies them onto the volume; from then on they are yours to edit." />
            <ErrorBox error={presets.error} />
            {presets.data?.length === 0 && <Empty>No presets found in presets/.</Empty>}
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {presets.data?.map((preset) => (
                    <div key={preset.name} className="card stack">
                        <div className="row between top">
                            <div>
                                <div style={{ fontWeight: 600 }}>{preset.title}</div>
                                <div className="dim small">{preset.description}</div>
                            </div>
                            {preset.installed && <span className="badge done">installed</span>}
                        </div>
                        <div className="row wrap">
                            {preset.tags.map((t) => (
                                <span key={t} className="badge tag">
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
                                <button className="sm" onClick={() => setOpen(preset)}>
                                    Details
                                </button>
                            )}
                            {preset.installed ? (
                                <button className="sm" onClick={() => install(preset, true)}>
                                    Reinstall
                                </button>
                            ) : (
                                <button className="sm primary" onClick={() => install(preset)}>
                                    Install
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {open && (
                <div className="card" style={{ marginTop: 16 }}>
                    <div className="row between">
                        <h3 style={{ margin: 0 }}>{open.title}</h3>
                        <button className="sm" onClick={() => setOpen(null)}>
                            Close
                        </button>
                    </div>
                    <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(open.readme ?? '') }} />
                </div>
            )}
            {toast}
        </div>
    )
}

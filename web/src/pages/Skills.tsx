import { useState } from 'react'

import { Editor, Field, str } from '../components/Editor'
import { FolderFiles } from '../components/Files'
import { SkillSecrets } from '../components/Secrets'
import { GrowingTextarea } from '../components/ui'
import type { CatalogEntry } from '../lib/api'

const TEMPLATE = `# <skill name>

Use this when …

## Steps

1. …
2. …

## Rules

- …
`

export function SkillsPage() {
    return (
        <Editor
            kind='skills'
            title='Skills'
            sub='Step-by-step procedures the dispatcher follows: feature-to-pr, onboard-project, your own. A skill is a directory: SKILL.md plus the scripts and references next to it, in data/claude/skills/<name>/.'
            defaults={{ description: '' }}
            template={TEMPLATE}
            bodyLabel='Procedure'
            bodyHint='Markdown: the steps the agent follows'
            intro='A skill is a procedure the agent follows step by step — feature-to-pr, onboard-project, anything you do the same way every time — with the scripts it runs next to it. Pick one from the list to edit it, or write a new one.'
            newLabel='New skill'
            form={(fm, set) => (
                <Field
                    label='Description — when this skill applies'
                    hint='Claude Code decides to load the skill from this sentence.'
                    wide
                >
                    <GrowingTextarea
                        value={str(fm.description)}
                        onChange={(e) => set({ description: e.target.value })}
                    />
                </Field>
            )}
            below={(_fm, _set, entry) => entry && <SkillFiles entry={entry} />}
        />
    )
}

/**
 * The files next to SKILL.md: tools the agent runs by the procedure
 * (`${CLAUDE_SKILL_DIR}/scripts/…`), references it reads. Each file is saved
 * on its own, apart from the SKILL.md form.
 */
function SkillFiles({ entry }: { entry: CatalogEntry }) {
    const [open, setOpen] = useState<string | null>(null)
    // A saved script may declare new names: the secrets section reads the folder again.
    const [version, setVersion] = useState(0)
    return (
        <>
            <SkillSecrets
                key={version}
                skill={entry.name}
            />
            <FolderFiles
                kind='skills'
                name={entry.name}
                dir={entry.path.replace(/\/SKILL\.md$/, '')}
                open={open}
                onOpen={setOpen}
                onChanged={() => setVersion((v) => v + 1)}
            />
        </>
    )
}

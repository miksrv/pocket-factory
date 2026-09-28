import { Editor, Field, str } from '../components/Editor'

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
            kind="skills"
            title="Skills"
            sub="Step-by-step procedures the dispatcher follows: feature-to-pr, onboard-project, your own. Files in data/claude/skills/<name>/SKILL.md."
            defaults={{ description: '' }}
            template={TEMPLATE}
            bodyLabel="Procedure (Markdown)"
            form={(fm, set) => (
                <Field label="Description — when this skill applies" hint="Claude Code decides to load the skill from this sentence.">
                    <input value={str(fm.description)} onChange={(e) => set({ description: e.target.value })} />
                </Field>
            )}
        />
    )
}

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
            intro="A skill is a procedure the agent follows step by step — feature-to-pr, onboard-project, anything you do the same way every time. Pick one from the list to edit it, or write a new one."
            newLabel="New skill"
            form={(fm, set) => (
                <Field label="Description — when this skill applies" hint="Claude Code decides to load the skill from this sentence.">
                    <input value={str(fm.description)} onChange={(e) => set({ description: e.target.value })} />
                </Field>
            )}
        />
    )
}

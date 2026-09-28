import { Editor, Field, str } from '../components/Editor'

const MODELS = ['', 'sonnet', 'opus', 'haiku', 'inherit']

const TEMPLATE = `You are the <role> of a personal software factory.

Input you get: …

How you work:

1. …
2. …

Report back in a few lines. No tool logs.
`

export function AgentsPage() {
    return (
        <Editor
            kind="agents"
            title="Agents"
            sub="Claude Code sub-agents: roles with their own tools, model and system prompt. Files in data/claude/agents/."
            defaults={{ description: '', tools: 'Read, Edit, Write, Bash, Grep, Glob', model: 'sonnet' }}
            template={TEMPLATE}
            bodyLabel="System prompt (Markdown)"
            form={(fm, set) => (
                <>
                    <Field label="Description — when the dispatcher should use this agent" hint="Claude Code matches tasks to agents by this text. Be specific.">
                        <input value={str(fm.description)} onChange={(e) => set({ description: e.target.value })} />
                    </Field>
                    <Field label="Tools (comma separated)" hint="Read-only agents: Read, Bash, Grep, Glob. Omit to inherit all tools.">
                        <input className="mono" value={str(fm.tools)} onChange={(e) => set({ tools: e.target.value })} />
                    </Field>
                    <Field label="Model">
                        <select value={str(fm.model)} onChange={(e) => set({ model: e.target.value })}>
                            {MODELS.map((m) => (
                                <option key={m} value={m}>
                                    {m || 'CLI default'}
                                </option>
                            ))}
                        </select>
                    </Field>
                </>
            )}
        />
    )
}

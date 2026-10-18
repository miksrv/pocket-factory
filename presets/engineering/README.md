# Engineering skills

Eight skills copied as they are from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see `LICENSE`), chosen for work an agent does on its own in the factory, not for an interactive session:

| Skill | What it gives the agent |
|---|---|
| `tdd` | the red → green loop with tests that survive refactors (`tests.md`, `mocking.md`) |
| `code-review` | a review along two axes, standards and spec, as parallel sub-agents |
| `diagnosing-bugs` | build a feedback loop that goes red on the bug first, then minimise, hypothesise, fix, regression-test; `scripts/hitl-loop.template.sh` for the steps only a human can do |
| `pr` | the shape of a pull request body: the smallest visual that explains the change, evidence, merge danger |
| `research` | investigate against primary sources and keep the findings as a cited Markdown file |
| `codebase-design` | the vocabulary of deep modules, seams and interfaces (`DEEPENING.md`, `DESIGN-IT-TWICE.md`) |
| `writing-for-agents` | how to write skills, agent files and CLAUDE.md so an agent follows them |
| `retro` | what to improve in the agent's environment after a session, most severe first |

How they fit the factory: a project's **notes** are the "issue tracker" and the coding standards these skills look for (`code-review` reads `CONTRIBUTING.md` / `CODING_STANDARDS.md` when the repository has them); `feature-to-pr` can name `tdd` for the build step and `pr` for the body; a routine can hand `research` a question. The skills that need a person in the loop (`grill-me`, `wayfinder`, `to-tickets`, `ask-matt`, `setup-matt-pocock-skills`) are left out on purpose: a routine run has nobody to interview.

Update: re-run *Reinstall* after the repository's copy is refreshed from upstream (`presets/engineering/skills/<name>/`).

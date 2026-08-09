# agy-proxy Agent Skills

Curated skills from [mattpocock/skills](https://github.com/mattpocock/skills), copied into this
repo so coding agents (Claude Code, Hermes, etc.) can follow a consistent workflow.

**How to use:** when working in this repo, read the matching skill's `SKILL.md` before starting
the task. See root `CLAUDE.md` for the task→skill mapping table.

## Skills

| Skill | Purpose |
|-------|---------|
| **`operate-agyproxy`** | **Vận hành pool đang chạy: chẩn đoán lỗi/chậm, gỡ cooldown, nạp quota. KHÔNG phải sửa code.** |
| `code-review` | Review changes since a fixed point along Standards + Spec axes (parallel sub-agents). |
| `codebase-design` | Design modules "twice" before committing to one approach. |
| `diagnosing-bugs` | Systematic root-cause debugging (understand before fixing). |
| `domain-modeling` | Model domains with ADRs + context formats. |
| `git-guardrails-claude-code` | Block dangerous git commands via pre-commit guardrails. |
| `implement` | Build features with a structured implement → verify loop. |
| `improve-codebase-architecture` | Refactor / improve architecture with an HTML report. |
| `prototype` | Throwaway prototypes to validate an idea fast. |
| `research` | Research a topic thoroughly with agent support. |
| `resolving-merge-conflicts` | Resolve git merge conflicts safely. |
| `setup-pre-commit` | Set up pre-commit hooks (typecheck + build). |
| `tdd` | Test-driven development (red-green-refactor). |
| `triage` | Triage issues/bugs into actionable work. |
| `wayfinder` | Navigate a large codebase to find the right place to change. |

## Excluded (not dev-relevant)

`ask-matt`, `grill-me`, `grilling`, `grill-with-docs`, `teach`, `handoff`, `loop-me`,
`wait-what`, `writing-*`, `to-*`, `scaffold-exercises`, `migrate-to-shoehorn`,
`setup-matt-pocock-skills`, `setup-ts-deep-modules`, `claude-handoff`, `wizard`.

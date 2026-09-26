# Agent.md

## Must

- Understand the existing architecture before changing code.
- Prefer the smallest correct change.
- Use local references under `/home/lovedolove/projects/refs` when relevant.
- Verify changes with tests and real runtime behavior.
- Keep Veyra settings owned by Veyra.
- Preserve existing Veyra architecture and unrelated features.
- Never claim success without evidence.

## DSH Web Safety

- **NEVER kill DSH Web.**
- **NEVER stop DSH Web.**
- **NEVER restart DSH Web.**
- **NEVER start a second DSH Web.**
- **NEVER change the DSH Web port.**
- If a DSH Web restart is required, **STOP and tell the user**.

## Scope

- Do not modify DSH core or profile to work around Veyra problems.
- Do not make unrelated changes.
- Do not introduce new architecture without evidence and necessity.
- Do not use vision/image-capable workflows.

## Completion

Before reporting completion:

```text
Tests verified
Git diff reviewed
Runtime behavior verified when applicable
No unrelated changes
```

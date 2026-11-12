# PRD: Veyra Network Graph - Workspace Selector

## Goal
Enable users to switch between different workspaces directly from the Veyra Network Graph UI.

## Scope
- Server: Add an API endpoint `/veyra/workspaces` to list available workspaces.
- Client: Add a UI dropdown selector in `src/webui.css` / `src/webui-client.mjs` to fetch and switch workspaces.

## Success Criteria
- Workspace dropdown correctly populates from `runtime.memoryServer.resolver.list()`.
- Selecting a workspace triggers a page reload with the correct `?cwd=...` parameter.
- UI remains compliant with DSH fail-closed security for workspace resolution.

## Constraints
- Keep vanilla JS/CSS architecture.
- No new heavy dependencies.
- Match OLED visual theme.

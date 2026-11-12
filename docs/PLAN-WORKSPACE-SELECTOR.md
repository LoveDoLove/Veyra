# Plan: Workspace Selector Implementation

## Phase 1: Server Enhancement
- [ ] Modify `src/webui.mjs` to add `/veyra/workspaces` endpoint.
- [ ] Implement handler to call `runtime.memoryServer.resolver.list()`.

## Phase 2: Client Enhancement
- [ ] Update `src/webui.css` for the dropdown styling.
- [ ] Update `src/webui-client.mjs` to:
    - [ ] Fetch workspaces from `/veyra/workspaces`.
    - [ ] Inject dropdown into the UI.
    - [ ] Handle selection and reload with `?cwd=`.

## Phase 3: Validation
- [ ] Verify workspace list displays correctly.
- [ ] Verify switching workspaces reloads correctly.

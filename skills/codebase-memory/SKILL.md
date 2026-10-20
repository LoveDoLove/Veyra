---
name: codebase-memory
description: >
  Use Codebase Memory for structural code intelligence, AST-level navigation,
  call-graph tracing, and knowledge-graph code search. Prefer cbm_trace for caller/callee
  analysis, cbm_search for symbol discovery, cbm_snippet for exact definitions, and cbm_arch
  for component dependency overview. Provides precise structural graph vs noisy text search.
whenToUse: >
  Understanding repository structure, finding symbol definitions, tracing call hierarchies,
  analyzing blast radius / impact of code changes, or directory component architecture.
---

# Codebase Memory — Structural Code Intelligence

Codebase Memory provides structural AST-level code intelligence and call-graph navigation,
integrated natively into Veyra alongside engineering memory.

Web visual graph interface: http://localhost:9749/

## Quick Decision Matrix

| Question | Tool call |
|----------|----------|
| Who calls X? | `cbm_trace(direction="inbound")` |
| What does X call? | `cbm_trace(direction="outbound")` |
| Full call context | `cbm_trace(direction="both")` |
| Find by name pattern | `cbm_search(name_pattern="...")` |
| Impact of local changes | `cbm_trace` (impact) + `veyra_code_status` (freshness) |
| Text search | `cbm_search_code` or grep |

## Exploration Workflow

1. `cbm_projects` — pick the project whose `root_path` contains your working directory; pass its `name` (or the absolute directory itself) as `project`, never a repo or folder name.
2. `cbm_arch` — understand directory component dependencies and architecture overview.
3. `cbm_search(label="Function", name_pattern=".*Pattern.*")` — find code.
4. `cbm_snippet(qualified_name="...")` — read exact symbol definitions with minimal token overhead.

## Tracing Workflow

1. `cbm_search(name_pattern=".*FuncName.*")` — discover exact name.
2. `cbm_trace(function_name="FuncName", direction="both", depth=3)` — trace call hierarchies.

## Tools

- `cbm_projects`: List all projects currently indexed in codebase-memory-mcp.
- `cbm_search`: Discover functions, classes, interfaces, or files by name pattern, AST label, or file path pattern.
- `cbm_snippet`: Retrieve exact symbol definitions and their immediate context with minimal token overhead without reading whole files.
- `cbm_trace`: Trace inbound/outbound call paths through the knowledge graph from a specific symbol.
- `cbm_arch`: Directory-level component dependency and architectural overview.
- `cbm_search_code`: Fast regex search across indexed repository files.
- `veyra_code_status`: Check indexing status, freshness of evidence anchors, and affected memories.

## Evidence Tiers

- **Scout (Tier 1):** fast positive lookup with few graph calls and targeted source checks. Treat results as provisional; never make absence, exhaustive, dead-code, or complete-impact claims.
- **Verify (Tier 2, default):** task-directed searches, relevant trace directions, exact snippets for material claims, and all relevant result pages.
- **Auditor (Tier 3):** bounded-scope full verification with a current graph generation, complete relevant pagination, both call directions and broader relationships when material, plus explicit unresolved limitations.
- **Every tier:** after candidate paths are known, call `veyra_code_status` for freshness. For negative or exhaustive claims also inspect the relevant scopes. A clean result means no recorded gap, not proof of completeness. For partial, skipped, excluded, stale, pending, or unknown coverage, read/grep the reported ranges or scope before relying on the graph.

## Sessions and Subagents

- At session start or after compaction, confirm the nearest graph project and generation with `cbm_projects` / `veyra_code_status`, then choose Scout, Verify, or Auditor for the task.
- Before delegating, query the graph and coverage in the parent. Pass the tier, project, generation/freshness, bounded scope, queries and pagination state, qualified symbols, paths, call-chain findings, coverage evidence with ranges/reasons, source fallback already performed, and unresolved questions to the child.
- A child without MCP tools must not call or claim MCP access. It should work from the supplied evidence and use read/grep on exact source, especially every reported missed-coverage range.

## Quality Analysis

Veyra does not expose degree/relationship filters. Use `cbm_trace(direction="both")` to inspect
callers and callees of a symbol, and `cbm_search(name_pattern=...)` to locate candidate symbols.

## When to use Codebase Memory vs text grep / file tools

- **cbm_trace**: Trace caller/callee relationships, call hierarchies, and blast-radius / impact analysis (precise structural graph vs noisy text search).
- **cbm_search**: Discover functions, classes, interfaces, or files by name pattern or AST label.
- **cbm_snippet**: Retrieve exact symbol definitions and their immediate context with minimal token overhead without reading whole files.
- **cbm_arch**: Directory-level component dependency and architectural overview.
- **cbm_search_code**: Fast regex search across indexed repository files.
- **veyra_code_status**: Check indexing status, freshness of evidence anchors, and affected memories.
- **grep / read**: Use when editing files, reading non-code assets, or searching exact string literals.

## Core Rules & Invariants

1. **Repository Code is Authoritative**:
   The current code in the repository is the source of truth. Codebase Memory reflects the structural index of that code.
2. **Memory is Non-Authoritative**:
   Veyra engineering memories provide historical context and decisions. If a recalled memory contradicts current code, current repository code always wins.
3. **Graceful Degradation**:
   If the structural index is not yet built or unavailable, tools fallback gracefully without failing your workflow.

## Gotchas

1. `cbm_search` returns up to `limit` results (default 50) — raise `limit` for broader searches.
2. `cbm_trace` needs exact names — use `cbm_search(name_pattern=...)` first to discover the exact symbol name.
3. `cbm_trace(direction="outbound")` misses cross-service callers — use `direction="both"` for full call context.
5. `veyra_code_status` reports freshness of engineering memory anchors, not graph generation — use `cbm_projects` to confirm the indexed project and generation.

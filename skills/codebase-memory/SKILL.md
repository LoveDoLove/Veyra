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

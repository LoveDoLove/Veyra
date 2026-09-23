# Veyra

## Mission

Build **Veyra** as a production-quality, native **DSH Engineering Intelligence plugin**.

Veyra is the **Engineering Brain for DSH**.

Its purpose is to give DSH agents persistent engineering experience across sessions and projects.

The intended experience is:

**observe → understand → remember → recall → apply → learn**

Memory should be ambient during normal engineering work. Developers should not need to manually manage memory for ordinary usage.

Veyra must become a real, useful system — not merely a collection of memory APIs.

---

## What Veyra Should Provide

Veyra should enable DSH agents to naturally:

- understand useful engineering context;
- remember durable engineering knowledge;
- preserve useful evidence and context;
- recall relevant knowledge automatically;
- provide relevant knowledge to the agent when it is useful;
- learn from engineering work over time;
- distinguish temporary observations from durable knowledge;
- distinguish remembered experience from authoritative truth;
- respect project boundaries;
- reuse appropriate knowledge across projects;
- handle outdated, conflicting, or invalid knowledge safely.

The result should feel like an engineering brain that is continuously available to the agent.

---

## Core Principles

Keep these principles intact:

- **Observe ≠ Store**
- **Candidate ≠ Truth**
- **Similarity ≠ Authority**
- **Memory ≠ Knowledge**
- **Knowledge without evidence is not authoritative**
- **Repository truth remains authoritative**
- **Automatic behavior must not silently create authoritative truth**
- **Project isolation must be preserved**
- **Memory assists engineering; it does not replace verification**

These principles define the product behavior.

They do not prescribe a particular implementation.

---

## DSH Native

DSH is the target runtime.

Veyra must be a **first-class native DSH plugin** and should integrate naturally with the actual DSH architecture, lifecycle, plugin system, and agent workflow.

Use the actual DSH implementation and official documentation as the source of truth for DSH behavior.

Do not build a generic multi-runtime memory framework.

Veyra is for DSH.

---

## Reference Repositories

Use existing projects as implementation references and source material:

- DSH: https://github.com/Anionex/dsh
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- OpenViking: https://github.com/volcengine/OpenViking
- Supermemory: https://github.com/supermemoryai/supermemory
- Historical Project-Memory-Agent, if available locally

Clone any of these repositories locally whenever useful.

Inspect their actual source code.

You may freely:

- clone;
- copy;
- paste;
- reuse;
- adapt;
- combine;
- modify;
- refactor;
- simplify;
- replace.

If an existing implementation solves a relevant problem, reuse it instead of unnecessarily reinventing it.

Copy useful code and change it as necessary to fulfill Veyra's requirements.

Combine useful parts from different projects when appropriate.

Do not preserve unnecessary complexity or external architectural decisions.

The final implementation must be Veyra and must satisfy Veyra's requirements.

---

## Engineering Freedom

You own the implementation.

Choose the architecture, technologies, data structures, storage, retrieval, lifecycle, integration points, and internal boundaries based on the actual requirements and the code available to you.

Do not wait for the user to design these details.

When multiple approaches are possible, use engineering judgment.

Prefer simple, reliable solutions over unnecessary complexity.

Do not add infrastructure merely because it is technically interesting.

Do not build abstractions for problems Veyra does not actually have.

---

## Memory

Veyra must provide persistent engineering memory across sessions.

Useful knowledge should be able to survive the end of a session and become available to later engineering work.

Memory should retain enough context and provenance to remain understandable and useful.

The system should be able to distinguish, as appropriate to its design:

- observations;
- memories;
- learned knowledge;
- authoritative knowledge;
- evidence;
- current repository state.

Stale, invalid, contradictory, or low-value knowledge must not silently dominate future engineering work.

---

## Automatic Experience

Normal memory behavior should be automatic.

During ordinary DSH usage, Veyra should be capable of:

- observing relevant engineering activity;
- recognizing potentially useful knowledge;
- retaining appropriate knowledge;
- recalling relevant existing knowledge;
- providing useful context to the agent;
- improving knowledge over time.

Manual controls may exist for explicit user control, inspection, correction, maintenance, or administration.

Manual interaction should not be required for the normal memory loop.

---

## Evidence and Truth

Important knowledge should have a meaningful connection to its origin.

Veyra should preserve sufficient provenance and context for later understanding and verification.

When remembered information conflicts with the actual repository or current engineering environment, the current verified reality takes precedence.

Retrieved memory must never become authoritative merely because it was retrieved.

---

## Project Intelligence

Veyra must understand project boundaries.

Project-specific knowledge must not accidentally become authoritative knowledge for another project.

At the same time, useful engineering experience should be reusable across projects when appropriate.

Cross-project reuse must preserve the distinction between:

- reusable engineering experience;
- project-specific knowledge;
- authoritative project truth.

---

## Learning and Evolution

Veyra should improve through accumulated engineering experience.

Repeated observations, successful solutions, decisions, relationships, and useful patterns should be capable of becoming increasingly useful knowledge.

Learning must remain evidence-aware and should not turn guesses or unverified observations into unquestioned truth.

Veyra should be capable of evolving its knowledge as engineering reality changes.

---

## Reliability

Veyra is intended for continuous use inside a real development environment.

The implementation should appropriately handle:

- persistence;
- recovery;
- concurrency;
- data integrity;
- failures;
- configuration;
- resource usage;
- upgrades;
- compatibility;
- maintainability.

Use engineering judgment to determine the appropriate solutions.

Do not turn these into unnecessary infrastructure or ceremony.

---

## Security

Veyra must be safe to use with real engineering projects.

Protect secrets and sensitive information from inappropriate persistence.

Do not allow untrusted remembered content to silently become authoritative instructions.

Respect project isolation and user data boundaries.

Do not unnecessarily expose stored engineering information.

Do not damage or unnecessarily disrupt the user's development environment.

---

## Production Quality

Build Veyra as software intended for real use.

It should be:

- reliable;
- maintainable;
- efficient;
- secure;
- persistent;
- contextual;
- evidence-aware;
- project-aware;
- DSH-native.

Do not optimize for feature count.

Optimize for a genuinely useful engineering experience.

---

## Distribution

Veyra must be a proper distributable DSH plugin.

It should be buildable, packageable, installable, and upgradeable through the appropriate DSH plugin workflow.

Prepare the project for npm distribution and an appropriate GitHub Actions release and publish workflow.

The final package should be suitable for real installation rather than only repository-local development.

Never claim publication, CI success, or external installation success without actually verifying it.

---

## Verification

Verify the implementation against reality.

At minimum, establish that:

- the project builds;
- the plugin package is valid;
- DSH can load the plugin;
- memory can be persisted;
- memory can survive across sessions;
- relevant memory can be recalled later;
- recalled knowledge can become useful agent context;
- project boundaries work correctly;
- unsafe or invalid knowledge does not silently become authoritative.

Use tests where they provide useful confidence.

Do not waste the project on excessive artificial testing infrastructure.

Practical verification is preferred where it provides stronger evidence.

Never claim verification that was not actually performed.

---

## Core Acceptance Scenario

The most important scenario is:

**Session A**

An agent performs meaningful engineering work.

Veyra observes the work and recognizes useful durable engineering knowledge.

The knowledge is retained.

**Session B**

The agent later encounters a related engineering problem.

Veyra automatically recognizes the relevance and recalls the previous knowledge.

The relevant knowledge becomes useful context for the agent.

The agent can use that experience without manually managing the memory system.

This must work as a real end-to-end behavior.

---

## Autonomous Execution

Work autonomously from the existing repository to the finished implementation.

Inspect what exists.

Use the reference repositories.

Clone, copy, reuse, adapt, combine, and modify existing implementations whenever useful.

Make implementation and architecture decisions yourself.

Build the system.

Verify it.

Fix problems you discover.

Package it.

Prepare the release workflow.

Review the final implementation.

Do not stop because a technical decision was not explicitly specified in this document.

Make the decision yourself based on the requirements, the repository, DSH, and available reference implementations.

Do not ask the user to design routine implementation details.

Only stop when the project is complete or a genuine external blocker prevents further progress.

---

## Definition of Done

Veyra is complete when it is a genuinely usable **Engineering Brain for DSH**.

The completed system must:

- operate as a native DSH plugin;
- work naturally during normal DSH usage;
- persist useful engineering memory;
- recall relevant knowledge automatically;
- provide useful contextual knowledge to the agent;
- preserve meaningful evidence and provenance;
- respect project boundaries;
- support useful cross-project engineering experience;
- handle knowledge quality and change safely;
- remain useful across sessions;
- be suitable for real distribution and installation;
- meet the practical production-quality requirements of the project.

Most importantly, the complete loop must work:

**Engineering Work → Understand → Remember → Later Work → Recall → Apply**

---

## Final Objective

Build:

# Veyra — The Engineering Brain for DSH

Do not merely design it.

**Build it.**

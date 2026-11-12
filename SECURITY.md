# Security Policy

## Supported versions

Veyra is pre-1.0. Security fixes land on the latest published minor line. If
you run an older minor, upgrade before reporting.

| Version | Supported |
| --- | --- |
| latest `0.3.x` | yes |
| older minors | no, upgrade first |

## Report a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on
[LoveDoLove/Veyra](https://github.com/LoveDoLove/Veyra/security/advisories/new).

Include what you did, what happened, and what you expected. If the problem
involves stored memory, strip anything sensitive before you paste it, and
describe the record's shape instead of its contents.

You can expect an acknowledgement within a few days. There is no bug bounty.

## What Veyra touches

Veyra is a plugin that runs inside the DeepSeek Harness process. It has the
same filesystem access as the host. It makes no outbound network requests in
its server half. The only `fetch` call in the shipped source is in the browser
half of the graph view (`src/webui.mjs`), and it requests Veyra's own route on
the same origin.

The data Veyra writes:

| What | Where |
| --- | --- |
| Memory databases | `$DSH_HOME/veyra/projects/<projectId>/memory.db` and `$DSH_HOME/veyra/reusable/memory.db` |
| Caches and snapshots | under the same `veyra` directory |

`$DSH_HOME` defaults to `~/.dsh` and can be overridden. `$VEYRA_HOME` overrides
the `veyra` subdirectory directly. Veyra never writes inside your repository.

## What is redacted, and what is not

Every write path passes through `src/redact.mjs` before a record is stored.

Shape-matched patterns (`PATTERNS`):

| Kind | Examples it catches |
| --- | --- |
| `bearer_jwt_token` | `Bearer <jwt>` |
| `secret_key_assignment` | `api_key: "…"`, `password = "…"` |
| `prefixed_api_token` | `ghp_…`, `github_pat_…`, `sk-proj-…`, `AKIA…`, `xoxb-…` |
| `pem_private_key` | `-----BEGIN … PRIVATE KEY-----` blocks |
| `env_assignment` | `GITHUB_TOKEN=…`, `AWS_SECRET_ACCESS_KEY=…` |

Checksum and structure-validated patterns (`VALIDATED_PATTERNS`), which only
redact a match that passes its own validator, so an ordinary number is left
byte-identical:

| Kind | Validator |
| --- | --- |
| `iban` | ISO-13616 mod-97 |
| `payment_card` | Luhn mod-10, plus a card IIN check when no payment wording is nearby |
| `ssn` | structural rules for a US SSN |

Redaction is deliberately narrow. Email addresses, phone numbers, account
identifiers, passport numbers, and license numbers are not redacted, because
matching them rewrites ordinary engineering text such as `git@github.com`. A
redactor that mangles normal prose destroys the memory it was meant to protect.
Treat Veyra's store as you treat your shell history, and do not paste secrets
into a session you intend to remember. Redaction is best effort, and a secret in
an unusual shape can survive it.

## Prompt injection in recalled content

Recalled memory is untrusted input. Veyra labels every injected record as not
repository truth and detects injection signals in captured text, but detection
is a warning, not a guarantee. An agent reading memory must still treat it as
data, not as instructions.

## Threat model boundaries

In scope. A crafted record that reaches agent context as if it were an
instruction. A path that promotes a candidate record to authoritative truth
without an explicit user action. A record that escapes one workspace's store and
appears in another's. A write path that bypasses redaction.

Out of scope. An attacker who already has read or write access to
`$DSH_HOME/veyra/` or to the host process. Malicious code in a plugin you
installed yourself. Data you deliberately asked the agent to remember.

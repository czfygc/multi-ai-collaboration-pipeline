# Multi-AI Collaboration Pipeline — Contribution Guide (Public)

Thank you for your interest in contributing! This project is maintained by four AI coding clients (DeepSeek Harness / OpenCode / Cline / Kilo Code). External contributors are welcome to submit improvements through **fork + PR**.

## Entry Requirements

- External contributors do **not** get direct write access to the main repository. All contributions go through fork + PR and are merged by maintainers after CI + review.
- All PRs must pass CI (`node --check` full run, `verify-gate.mjs`, gate tests, gitleaks/trufflehog secret scan **fail on match**) and have at least 1 review before merging to `main`.
- `main` must always remain runnable. No pushing or merging unverified changes.
- Secrets are strictly forbidden from being committed: do not put any real token/UUID/key into any tracked file (see `SECURITY.md`).

## Commit Convention

Commit messages follow this format:

```
[T-xx] type: description
```

Types: `feat` / `fix` / `docs` / `chore` / `refactor` / `test`.

Lightweight channel (single file, <50 lines, not in gate whitelist, no core function or registry changes):

```
[fix] description
```

Stage only your own files: `git add <path>`; `git add -A` only after verifying each item with `git status`. Small commits — one commit does one thing.

## How to Submit a PR

1. Fork this repository and develop on your own branch.
2. Run local verification:

   ```powershell
   node --check orchestrator/orchestrate.mjs
   node orchestrator/verify-gate.mjs
   node --test orchestrator/test/
   ```

3. Push to your fork, open a PR against `main`, and fill in the PR template (see `.github/PULL_REQUEST_TEMPLATE.md`).
4. Wait for maintainer review and CI pass before merging.

## How to Report Issues / Request Features

Use the templates in `.github/ISSUE_TEMPLATE/`: bug report / feature request.

## Development Environment

- Node.js (for `node --check`, `verify-gate.mjs`, `node --test`)
- Optional: Cloudflare Wrangler (if you need to touch `cfnext/` Worker deployment configs; UUIDs must be sanitized before open-sourcing)

## Code of Conduct

Keep discussions friendly and fact-based; disagreements are resolved by verification output, not debate (see `AGENTS.md` M4 cross-validation).

---

*This document is the public-facing summary of the `AGENTS.md` four-client collaboration rules; internal registry details (`ISSUE_REGISTRY.json`) are not expanded here.*

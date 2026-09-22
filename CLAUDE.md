# Network Builder — working conventions

## Git: commands are handed over, never run

This project follows the global rule: an agent does **not** run `git commit`, `git push`,
`gh repo create` or `gh pr create`. Work is staged, then the exact commands are handed to
the maintainer to run, with a note on what each commit covers and why its message reads
the way it does.

This is deliberate and was reconfirmed when the PR workflow below was adopted. A request
to "open a PR" is a request about branch and commit *structure*, not authority to run git.

## The repo is part of the product

This project teaches how to build scalable networks. The commit history and PR
descriptions are read as documentation, so they are deliverables rather than hygiene:

- **One PR per coherent concept**, on its own branch, **5–7 atomic commits**. Each commit
  builds and tells one story. No `wip`, no `fix typo` noise.
- **PR descriptions teach.** Open with what concept this adds and why, not a changelog.
- **ADRs record rejected alternatives**, not just the decision. Why we did *not* build a
  discrete-event simulator is worth more to a reader than the choice we made.
- **Commits read as a sequence.** A reviewer should be able to read one PR's commits in
  order and understand how the thing was assembled.

Branch naming: `docs/roadmap`, `feat/sim-core`, `feat/catalog-ports`.

**Commit messages are short.** A one-line subject in the imperative, conventional-commit
prefixed. Add a body only when the *why* is not obvious from the subject, and keep it to a
line or two. No co-author trailers, no tool or session attribution, no generated-with
footers — in commit messages or PR descriptions.

## Publishing

This repo is public. Before any push that adds content sourced from outside this project,
run a full personal-data sweep across every folder and report findings for confirmation
first.

## Stack

Per the workspace `frontend-ui-stack` convention: Vite + React (not Next.js — no SSR/SEO
need), Tailwind v4, shadcn/ui on Base UI primitives, DTCG design tokens compiled with
Style Dictionary. Never hardcode a colour, spacing, radius or font-size value — reference
a token. Verify both light and dark themes before calling UI work done.

## Scope discipline

Default to the smallest change that satisfies the stated requirement. No unrequested
tests, retries, refactors or "while I'm in here" polish.

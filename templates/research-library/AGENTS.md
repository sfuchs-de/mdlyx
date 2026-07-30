# Research-library instructions

## Before changing research content

- Read `projects/__PROJECT_KEY__/index.md` and
  `projects/__PROJECT_KEY__/references/provenance.md`.
- Identify the declared source authority and summarize the proposed change
  before editing.
- Treat Markdown owner notes as scholarly content, not generated fixtures.

## Integrity rules

- Preserve stable document IDs and project keys when files move.
- Do not promote validation states, change dependencies, or alter source
  authority without explicit evidence and user approval.
- Do not invent citations, results, proofs, empirical checks, or provenance.
- Keep unknown frontmatter keys, comments, authored ordering, and source
  formatting intact.
- Use `[[document-id|label]]` for internal document navigation.
- Record unresolved proof obligations and failed checks rather than hiding them.

## Verification

- Run `npm run library:validate -- --root <library-path>` from an MdLyx source
  checkout after structural changes.
- Report files changed, validation results, and any remaining diagnostics.
- Prefer a branch and reviewed pull request for changes to IDs, dependencies,
  validation states, or source authority.

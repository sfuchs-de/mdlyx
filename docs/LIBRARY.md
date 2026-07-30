# Library format

A library is a folder containing Markdown documents. Nested folders are
supported. Each indexed document uses a stable ID in one-line frontmatter:

```yaml
---
library: {"id":"sample-model","title":"Sample model","kind":"derivation","projects":["sample-project"],"status":"review"}
---
```

The folder name is not part of link identity. This allows documents to move
without breaking `[[sample-model]]` links.

Optional project workspaces are authored in Markdown:

- `contains: ["project-overview"]` identifies the overview.
- `contains: ["dependency-graph"]` identifies the result manifest.
- `## Reading path {#reading-path}` supplies the curated navigation order.
- `## Project priorities {#project-priorities}` supplies project tasks.
- `## Key results {#key-results}` supplies editorially important results.

Project result manifests use:

```markdown
| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
```

Validation states are `validated`, `partial`, `unvalidated`, and `disputed`.
Task states are `next`, `in-progress`, `blocked`, `later`, and `done`.

Use `npm run audit:overview -- /path/to/library --strict` to validate a library
that includes a compatible review baseline.

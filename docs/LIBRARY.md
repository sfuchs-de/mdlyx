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

Use the general validator for any readable Markdown library:

```bash
npm run library:validate -- --root /path/to/library
```

It does not require fixed project counts or a governance lock. Mature governed
libraries can additionally use:

```bash
npm run audit:overview -- /path/to/library --strict
```

That advanced command requires a compatible `library-review.yaml` and
deterministic lock. See [Create a research library](CREATE_LIBRARY.md).

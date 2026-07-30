# Writing and linking

MdLyx stores ordinary Markdown with a small amount of structured metadata.

Common shortcuts:

- `Cmd/Ctrl-B` and `Cmd/Ctrl-I`: emphasis
- `Cmd/Ctrl-M`: inline equation
- `Cmd/Ctrl-Shift-M`: display equation
- `Cmd/Ctrl-S`: save
- `F1`: open the in-app writing guide

Internal document links use stable frontmatter IDs:

```markdown
[[result-note]]
[[result-note|Readable label]]
[[result-note#proof:main|Open the proof]]
```

In an editable document, use Cmd/Ctrl-click, double-click, Enter on a selected
link, or a second touch to navigate. A normal click keeps the caret available.

Pandoc citations use `[@key]`; bibliographies are BibTeX files declared in
publication metadata. Labels such as `{#eq:identity}` can be referenced with
`@eq:identity`. Theorem and proof blocks use fenced divs:

```markdown
::: theorem {#thm:sample}
Every continuous function on a compact set is bounded.
:::
```

See [`sample-library/`](../sample-library/) for a small complete project.

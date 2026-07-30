# Create a research library

A library is a folder of canonical Markdown notes and project assets. Creating
one is a curation decision, not a bulk file conversion: establish authority,
stable identities, ownership, and validation discipline before importing large
amounts of material.

## Initialize

Run this from an MdLyx source checkout:

```bash
npm run library:init -- \
  --target ~/Research/my-library \
  --project-key my-project \
  --title "My Research Project"
```

Options:

- `--authority mdlyx` makes the new Markdown library canonical. This is the
  default.
- `--authority external` records that another manuscript or repository remains
  canonical.
- `--authority split` records that authority differs by content class; describe
  the split in the generated provenance note.
- `--git` initializes a local `main`-branch Git repository. It creates no
  commit, remote, account, or publication.

The command refuses filesystem roots, unsafe project keys, symbolic-link
targets, and nonempty directories.

## Generated structure

```text
my-library/
├── README.md
├── AGENTS.md
└── projects/
    └── my-project/
        ├── index.md
        ├── derivations/
        │   └── 01-foundations.md
        ├── synthesis/
        │   └── full-chain.md
        ├── verification/
        │   └── dependencies.md
        └── references/
            ├── notation.md
            ├── provenance.md
            └── library.bib
```

The overview supplies the project summary, reading path, publication defaults,
and task table. Derivation notes own mathematical steps. The synthesis connects
them in argument order. The dependency manifest records formal results,
evidence, dependencies, and remaining conditions.

## Stable identity

Every indexed document has a frontmatter ID:

```yaml
---
library: {"id":"my-project-foundations","title":"Foundations","kind":"derivation","status":"draft","projects":["my-project"],"contains":["derivations"]}
---
```

Paths organize files; IDs provide identity. Preserve the ID when moving or
renaming a document so `[[my-project-foundations]]` links continue to work.
Result and task IDs are similarly stable and should never be silently reused.

## What belongs in a derivation

A useful derivation normally records:

1. Reader orientation: inputs, outputs, and downstream consumers.
2. Objects and domains.
3. Assumptions.
4. Semantic derivation steps.
5. A precise result statement, when one is ready.
6. Symbolic, numerical, dimensional, or limiting-case checks.
7. Failure conditions and unresolved obligations.
8. Source and verification anchors.

Do not add a dependency-manifest row merely because a formula exists. Add it
when the claim has a stable ID, owner, evidence, validation state, and remaining
condition.

## Migrate existing research

1. Inventory the current manuscript, notes, code, data, and upstream sources.
2. Choose `external` or `split` authority if another source remains canonical.
3. Create stable document IDs before moving files.
4. Import one coherent model block at a time.
5. Add links and notation without changing the mathematical claim.
6. Record provenance and source revisions.
7. Add formal results only after checking their owner and evidence.
8. Write the synthesis after the owner notes are coherent.

Never infer validation from polished prose, document status, downstream use, or
an AI-generated explanation.

## Validate

The general validator requires no count lock or governance configuration:

```bash
npm run library:validate -- --root ~/Research/my-library
npm run library:validate -- \
  --root ~/Research/my-library \
  --json validation-report.json
```

It checks metadata, stable IDs, project workspaces, tasks, result dependencies,
wiki links and anchors, bibliography paths, citation keys, and root escapes.
Errors produce a nonzero exit status; warnings remain visible without blocking
early drafting.

`npm run audit:overview -- /path/to/library --strict` is for mature governed
libraries with `library-review.yaml` and a deterministic count lock. Introduce
that contract when count drift, accepted diagnostics, source pins, and
project-matrix CI need formal review.

## Add private Git storage

After reviewing the generated files:

```bash
cd ~/Research/my-library
git add README.md AGENTS.md .gitignore projects
git commit -m "Initialize research library"
```

Create a **private** remote through your preferred Git provider, review the
destination, and push it explicitly. The initializer never performs this step.
Continue to [private GitHub synchronization](GITHUB_SYNC.md) only if the MdLyx
application itself must read and commit that repository.

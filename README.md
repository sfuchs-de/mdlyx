# MdLyx

MdLyx is a local-first editor for mathematical and technical Markdown. Markdown
remains the source of truth while the app provides live equations, theorem and
proof blocks, internal references, comments, project overviews, dependency
graphs, bibliographies, and TeX export.

The public edition contains no bundled private research, central account,
analytics, or managed sync service.

## Try it in five minutes

1. Open the [public demo](https://sfuchs-de.github.io/mdlyx/).
2. Choose **Library → More → Switch source → Open local folder** and select a
   copy of [`sample-library/`](sample-library/).
3. Open `Project Overview`, follow an internal document link, and inspect the
   dependency graph.
4. Edit a copy of a document and save it.

The demo is a static application. Files remain in the browser or in a folder
that you explicitly authorize. Static hosting does **not** upload local files or
enable GitHub synchronization.

## Choose how to use MdLyx

| Path | Where research is stored | What is hosted | Best for |
| --- | --- | --- | --- |
| [Public demo](docs/GETTING_STARTED.md#public-demo) | Browser or an authorized local folder | Existing GitHub Pages app | Trying MdLyx immediately |
| [Personal deployment](docs/HOSTING.md) | Browser or an authorized local folder | Your GitHub Pages fork | A stable URL under your control |
| [Desktop app](docs/DESKTOP.md) | Native folders on your computer | Nothing | Offline and local research |
| [Private GitHub library](docs/GITHUB_SYNC.md) | Your private GitHub repository | Your Render API and Redis | Multi-device access and coauthors |

All four paths use the same Markdown files. Start with the demo or desktop
application; add a server only when you actually need remote synchronization.

## Create a research library

Requirements: Node.js 22 and npm 11.

```bash
git clone https://github.com/sfuchs-de/mdlyx.git
cd mdlyx
npm ci
npm run library:init -- \
  --target ~/Research/my-library \
  --project-key my-project \
  --title "My Research Project"
npm run library:validate -- --root ~/Research/my-library
```

The initializer is deterministic and network-free. It creates a neutral project
overview, derivation, synthesis, verification manifest, notation, provenance,
bibliography, and research-oriented `AGENTS.md`. It does not create a remote,
publish files, or invent scholarly results. Add `--git` only if you want a local
Git repository with no commit or remote.

See [Create a research library](docs/CREATE_LIBRARY.md) for authority choices,
project structure, migration from existing notes, and validation.

## Run MdLyx locally

```bash
npm run dev
```

Open the displayed URL and select the initialized library folder. The editor
also works without a library through **File → Open**. Browsers without the File
System Access API download updated files instead of writing them in place.

## GitHub is used in several different ways

| Component | Purpose | Required? |
| --- | --- | --- |
| GitHub Pages | Hosts static MdLyx assets | Only for a personal web URL |
| Research-library repository | Stores your Markdown and assets | Only for Git-based storage |
| MdLyx GitHub App | Lets your self-hosted API read and commit library files | Only for in-app GitHub sync |
| ChatGPT/Codex GitHub connector | Gives an AI separately authorized repository access | Only for remote AI workflows |
| Local Git checkout | Gives local Codex direct filesystem context | Recommended for full local AI work |

These credentials and permissions are independent. Installing a connector does
not configure MdLyx sync, and configuring the MdLyx GitHub App does not give an
AI access to the repository. See [AI-assisted workflows](docs/AI_WORKFLOWS.md)
and [private GitHub synchronization](docs/GITHUB_SYNC.md).

## Features

- Live KaTeX equations with optional MathLive editing.
- Markdown round-tripping for headings, lists, tables, footnotes, figures,
  citations, raw LaTeX, theorem/proof blocks, labels, and references.
- Stable internal links such as `[[document-id|label]]` and result references.
- Multi-tab editing, autosave, IndexedDB recovery, and recovery export.
- Browser-folder and native-folder libraries with nested paths.
- Project overviews, reading paths, task tables, key results, and dependency
  graphs generated from Markdown.
- BibTeX catalogs, Pandoc citations, and BibLaTeX-aware TeX export.
- Anchored comments and project-scoped coauthor roles in self-hosted sync mode.
- Dark mode, responsive phone layouts, keyboard navigation, and accessible
  status labels.

## Documentation

### Set up and operate

- [Getting started](docs/GETTING_STARTED.md)
- [Create a research library](docs/CREATE_LIBRARY.md)
- [Host the static app](docs/HOSTING.md)
- [Configure private GitHub sync](docs/GITHUB_SYNC.md)
- [Use a library with Codex or ChatGPT](docs/AI_WORKFLOWS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### Reference

- [Library format](docs/LIBRARY.md)
- [Writing and linking](docs/WRITING.md)
- [Privacy model](docs/PRIVACY.md)
- [Desktop builds](docs/DESKTOP.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
npm run docs:check
npm run typecheck
npm test
npm run build
npm run build:api
npm run e2e
npm run lint:rust
npm run test:rust
npm run privacy:check
```

Install Playwright browsers once with `npm run e2e:install`. The optional Node
API is part of the authorization and file-format contract but is not required
for local use.

## Security and license

Do not put credentials in the browser bundle or commit `.env` files. GitHub App
private keys belong only in the self-hosted API environment. Report security
issues according to [SECURITY.md](SECURITY.md).

MdLyx is available under the [MIT License](LICENSE).

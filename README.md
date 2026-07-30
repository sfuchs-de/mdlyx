# MdLyx

MdLyx is a local-first editor for mathematical and technical Markdown. It keeps
Markdown as the source of truth while providing live equations, structured
references, theorem and proof blocks, comments, project libraries, dependency
graphs, bibliographies, and TeX export.

The public edition contains no bundled research library, account, analytics, or
hosted service. Open a folder that you control and MdLyx reads and writes the
files in that folder. Optional GitHub synchronization is self-hosted.

## Try it

Use the [hosted demo](https://sfuchs-de.github.io/mdlyx/) or run it locally.
The demo is the same static, local-first build: documents stay in your browser
or in folders that you explicitly open.

Requirements: Node.js 22 and npm 11.

```bash
git clone https://github.com/sfuchs-de/mdlyx.git
cd mdlyx
npm ci
npm run dev
```

Open the displayed local URL, select **Library**, and choose a copy of
[`sample-library/`](sample-library/).

The editor also works without a library: use **File → Open** for an individual
Markdown file. In browsers without the File System Access API, saving downloads
the updated file.

## Desktop app

The desktop shell uses Tauri and adds native folder access and atomic file
writes. Install the Rust toolchain, then run:

```bash
npm run tauri:dev
npm run tauri:build
```

The resulting local build is unsigned and does not include an automatic update
feed. See [Desktop builds](docs/DESKTOP.md).

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
- Anchored comments and replies stored in document frontmatter.
- Dark mode, responsive phone layouts, keyboard navigation, and accessible
  status labels.
- Optional owner-controlled GitHub library sync and project-scoped coauthor
  invitations when the companion API is self-hosted.

## Documentation

- [Library format](docs/LIBRARY.md)
- [Writing and linking](docs/WRITING.md)
- [Privacy model](docs/PRIVACY.md)
- [Desktop builds](docs/DESKTOP.md)
- [Optional GitHub sync](docs/SELF_HOSTING.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
npm run typecheck
npm test
npm run build
npm run build:api
npm run e2e
npm run lint:rust
npm run test:rust
npm run privacy:check
```

Playwright browsers are installed once with `npm run e2e:install`.

The optional Node API is included because it is part of the same authorization
and file-format contract. It is not required for local use.

## Security

Do not put credentials in the browser bundle or commit `.env` files. GitHub App
private keys belong only in the self-hosted API environment. Report security
issues according to [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

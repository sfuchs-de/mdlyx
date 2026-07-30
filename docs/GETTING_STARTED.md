# Getting started

The fastest route is the public demo. The most private route is a local folder
or desktop build. Both use the same Markdown format.

## Public demo

1. Open [the MdLyx demo](https://sfuchs-de.github.io/mdlyx/).
2. To try one document, choose **File → Open**.
3. To try project navigation, download or copy
   [`sample-library/`](../sample-library/) and choose
   **Library → More → Switch source → Open local folder**.
4. Open the project overview, dependency graph, and bibliography.

On Chromium browsers with the File System Access API, MdLyx can save back to an
authorized folder. Other browsers download the edited Markdown. Recovery
revisions stay in that browser’s IndexedDB.

The public demo has no account and no server-side document storage.

## Local web application

Install Node.js 22 and npm 11:

```bash
git clone https://github.com/sfuchs-de/mdlyx.git
cd mdlyx
npm ci
npm run dev
```

Open the URL printed by Vite. Choose **File → Open** for one document or open a
folder from the Library panel.

## Create your first library

From the MdLyx source checkout:

```bash
npm run library:init -- \
  --target ~/Research/my-library \
  --project-key my-project \
  --title "My Research Project"
npm run library:validate -- --root ~/Research/my-library
```

Open `~/Research/my-library` in the Library panel. Begin with the generated
project overview and provenance note. The placeholders deliberately contain no
invented result or validation claim.

Read [Create a research library](CREATE_LIBRARY.md) before importing an existing
manuscript or repository.

## Desktop application

The Tauri desktop shell provides native folder pickers and atomic local writes.
It is useful when browser folder permissions are inconvenient or offline work is
important.

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:dev
```

Public source builds are unsigned development builds with no shared update
feed. See [Desktop builds](DESKTOP.md).

## What to do next

- Keep everything local: continue with the demo, local web build, or desktop.
- Give the static app your own URL: [deploy a GitHub Pages fork](HOSTING.md).
- Synchronize through a private Git repository:
  [configure the optional API](GITHUB_SYNC.md).
- Work with an AI assistant safely:
  [use the generated repository guidance](AI_WORKFLOWS.md).

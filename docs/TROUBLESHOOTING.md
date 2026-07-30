# Troubleshooting

## A local folder will not open

- Use a Chromium browser for the most complete File System Access support.
- Reopen the Library and grant folder permission after a browser restart.
- Do not select a file when the picker expects a folder.
- Check whether organization policy or private browsing disables persistent
  handles.
- Use the desktop build when repeated browser authorization is disruptive.

## Saving downloads a file

The browser does not expose writable file handles on every platform. A download
is the safe fallback. Move the downloaded Markdown into the canonical library
or use Chromium, desktop mode, or self-hosted GitHub sync.

## A document is missing from the Library

Confirm that it:

- ends in `.md` or `.markdown`;
- has valid frontmatter;
- has a stable `library.id`;
- is not hidden by the current project, search, or attention filter;
- belongs to the expected project;
- is not a support-only file.

Run:

```bash
npm run library:validate -- --root /path/to/library
```

## An internal link does not open

Links target stable IDs, not filenames:

```markdown
[[document-id]]
[[document-id|Readable label]]
[[document-id#anchor|Open section]]
```

Check for duplicate IDs, a missing target, a missing anchor, or a coauthor grant
that does not include the target project. The validator reports each case.

## Overview or Graph is unavailable

Each project needs exactly one document containing `project-overview` and one
dependency manifest containing `dependency-graph`. Required headings and table
columns are documented in [Library format](LIBRARY.md).

An empty draft dependency table is valid. Duplicate authoritative documents are
rejected rather than merged.

## A citation remains raw

Confirm the project overview declares a bibliography, the path is relative and
contained within the library, the BibTeX file parses, and the citation key
exists. An explicit document `bibliography: []` disables project inheritance.

## Browser recovery looks stale

Use **Settings → Data** to inspect recovery revisions or export a recovery
bundle before clearing local data. Clearing site data removes browser recovery
and stored folder handles; it does not delete local or GitHub files.

## Static deployment cannot connect to GitHub

That is expected. The credential-free GitHub Pages and root Render Blueprints
provide local-folder mode only. Deploy the Node API and Redis described in
[Private GitHub synchronization](GITHUB_SYNC.md) for remote storage.

## GitHub sign-in does not return

- Check the GitHub App callback URL and `APP_ORIGIN`.
- Verify the client ID and secret belong to the same App.
- Confirm the authenticated login matches `ALLOWED_GITHUB_LOGIN`.
- Check `/health` and `/ready`.
- Inspect sanitized Render logs using the request ID shown by an error.

## Desktop sign-in or sync fails

The desktop application must be built with the correct
`VITE_LIBRARY_API_URL`, and the API must list the packaged Tauri origin in
`DESKTOP_APP_ORIGINS`. Production device authorization also requires Redis.

An unsigned public development build has no shared release feed. This is
independent of library authentication.

## A Render deployment is not ready

Verify:

- the private Redis service is running;
- `REDIS_URL` comes from that service;
- `PENDING_DEVICE_STORE=redis`;
- the GitHub App PEM secret file exists at the configured path;
- every required server variable is present;
- the Node service and callback use the same HTTPS origin.

Do not work around readiness by exposing secrets to the browser or falling back
to in-memory authorization in production.

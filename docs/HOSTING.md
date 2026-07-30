# Host the static application

Static hosting gives MdLyx a stable web URL. It does not store research files,
create an account, or enable GitHub synchronization. Users still open local
folders or individual files.

## Recommended: GitHub Pages

1. Fork the [MdLyx repository](https://github.com/sfuchs-de/mdlyx).
2. Open the fork’s **Actions** page and enable workflows if GitHub asks.
3. In **Settings → Pages**, select **GitHub Actions** as the source.
4. Open **Actions → Deploy public demo** and run the workflow, or push to
   `main`.
5. Open the deployment URL shown by the `github-pages` environment.
6. Open a copy of [`sample-library/`](../sample-library/) and verify editing,
   saving, internal links, Overview, and Graph.

The included build uses relative asset paths, so it works at a repository
subpath such as `https://account.github.io/mdlyx/`.

## Custom domain

Configure the domain in **Settings → Pages**, add the DNS records GitHub
requests, and enable HTTPS after the certificate is ready. Do not add a
repository-specific base path to Vite; the relative build already supports both
subpaths and root domains.

## Updating a fork

Sync the fork from upstream, review the changes, and let the Pages workflow
deploy the new commit. A static browser build has no desktop updater and cannot
update a separately installed Tauri application.

## Render static alternative

The root [`render.yaml`](../render.yaml) deploys the same credential-free static
application. Connect a fork in Render and create a Blueprint from that file.
No secrets are required. This remains local-folder mode.

Use [the GitHub-sync deployment](GITHUB_SYNC.md) only when remote library
storage is required. That deployment includes a server and Redis and has a
different security and cost profile.

## Privacy check

In a static deployment:

- Markdown is read only after a user opens a file or folder.
- Browser recovery stays in IndexedDB on that device.
- The host receives ordinary requests for application assets, not library
  contents.
- Other browser extensions, operating-system services, or user-installed
  software remain outside MdLyx’s control.

See the complete [privacy model](PRIVACY.md).

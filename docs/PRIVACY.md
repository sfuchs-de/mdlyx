# Privacy model

MdLyx is local-first.

- The public web build has no account system, telemetry, analytics, or remote
  library configured.
- Browser-folder access uses the browser's File System Access API and permission
  model. Recovery revisions are stored in that browser's IndexedDB.
- The Tauri app reads only files selected through native pickers and stores
  recovery state locally.
- External links open only after a user navigation gesture.
- A GitHub library is contacted only when an operator configures and hosts the
  optional companion API.
- A ChatGPT/Codex GitHub connector has separate authorization and does not
  receive MdLyx GitHub App credentials.

The repository's CI privacy check rejects credentials, private keys, absolute
home-directory paths, and identifiers from the private development deployment.
It cannot determine whether arbitrary prose is confidential; contributors must
not add personal libraries or unpublished research examples.

See [AI-assisted workflows](AI_WORKFLOWS.md) for repository-access boundaries
and [private GitHub synchronization](GITHUB_SYNC.md) for server-side secrets.

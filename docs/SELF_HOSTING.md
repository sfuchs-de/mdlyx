# Optional GitHub library sync

Local-folder mode needs no server. GitHub sync is an advanced, owner-operated
deployment that keeps GitHub credentials out of browsers and desktop apps.

## Components

1. A private repository containing your Markdown library.
2. A GitHub App installed only on that repository, with Contents read/write and
   Metadata read permissions.
3. The Node service in `server/`.
4. Redis for short-lived device authorization and invitation records.
5. A long random session secret and a separate invitation-token secret.

Copy `.env.example` to `.env`, fill every owner, repository, GitHub App, origin,
and secret value, and run:

```bash
npm run build
npm run build:api
npm run start:api
```

Set `VITE_LIBRARY_API_URL` and `VITE_APP_ORIGIN` to the deployed API origin when
building the hosted browser app. The API serves the SPA on that same origin so
the browser session remains first-party.

[`deploy/render-github-sync.example.yaml`](../deploy/render-github-sync.example.yaml)
is a template, not a ready-to-deploy Blueprint. Replace every placeholder and
review costs, regions, CORS origins, secret-file paths, and repository scope
before using it.

Never:

- expose the GitHub App private key to Vite;
- install the App on more repositories than required;
- reuse updater and writable-library credentials;
- make a private research library public merely to simplify setup.

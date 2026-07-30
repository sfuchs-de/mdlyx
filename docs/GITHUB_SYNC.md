# Private GitHub synchronization

GitHub sync is optional and owner-operated. The browser never receives a GitHub
App private key or installation token. The Node API performs authorized reads
and SHA-guarded commits on behalf of the signed-in user.

Static hosting alone does not provide this capability.

## Architecture

```text
browser ── first-party session ──> MdLyx Node API on Render
                                      │
                                      ├── short-lived records ──> private Redis
                                      │
                                      └── installation token ──> private library repository
```

The Render web service also serves the built SPA, keeping browser sessions
first-party. Redis stores expiring device-authorization and invitation records,
not research documents.

## Before you begin

You need:

- A private GitHub repository containing the library.
- A GitHub account allowed to own and administer the deployment.
- A Render account and approval for the private Key Value service’s cost.
- A public HTTPS service URL chosen before finalizing callback settings.

Initialize and validate the library first. Keep the repository private.

## Register the GitHub App

In GitHub, create a new GitHub App for this deployment:

1. Set the homepage URL to the final Render service origin.
2. Set the user-authorization callback URL to:

   ```text
   https://YOUR-SERVICE.onrender.com/auth/github/callback
   ```

3. Enable Device Flow if desktop authorization will be used.
4. Disable webhooks unless you independently need them; MdLyx v1 does not.
5. Grant repository permissions:
   - **Contents:** Read and write.
   - **Metadata:** Read-only.
6. Do not grant organization or repository permissions that are not listed.
7. Create a client secret and generate a private key.
8. Install the App on **only** the private research-library repository.
9. Record the App ID, client ID, client secret, and installation ID.

Treat the private key and client secret as credentials. Never put them in a
Vite variable, repository file, issue, screenshot, or AI prompt.

## Configure Render

Copy and review
[`deploy/render-github-sync.example.yaml`](../deploy/render-github-sync.example.yaml).
Replace service names and nonsecret placeholders before creating a Blueprint.
The template creates:

- One Node web service that builds the SPA and API.
- One private Redis-compatible Key Value service for expiring state.

Configure these values in the Render dashboard:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Exact HTTPS origin of the Node service |
| `API_ORIGIN` | The same origin |
| `VITE_LIBRARY_API_URL` | The same origin |
| `VITE_APP_ORIGIN` | The same origin |
| `ALLOWED_GITHUB_LOGIN` | Owner’s exact GitHub login |
| `LIBRARY_OWNER` | GitHub owner or organization of the library repository |
| `LIBRARY_REPO` | Repository name only |
| `LIBRARY_BRANCH` | Usually `main` |
| `LIBRARY_PROTECTED_BRANCH` | Usually `main` |
| `GITHUB_APP_ID` | App ID |
| `GITHUB_CLIENT_ID` | App client ID |
| `GITHUB_CLIENT_SECRET` | App client secret |
| `GITHUB_INSTALLATION_ID` | Installation ID |

Generate separate `SESSION_SECRET` and `INVITE_TOKEN_SECRET` values. Let the
Blueprint inject `REDIS_URL` from the private Key Value service.

Upload the GitHub App PEM as a Render Secret File at:

```text
/etc/secrets/mdlyx-github-app.pem
```

Set `GITHUB_PRIVATE_KEY_FILE` to that exact path. Do not paste the key into a
frontend or expose it through a `VITE_` variable.

## Deploy and verify

After deployment:

```bash
curl https://YOUR-SERVICE.onrender.com/health
curl https://YOUR-SERVICE.onrender.com/ready
```

`/health` must report the application configured. `/ready` must report ready
with the pending-device and invitation stores available. These responses do not
expose credentials.

Then perform this acceptance sequence:

1. Open the Render service URL.
2. Connect GitHub and complete owner authorization.
3. Confirm the Library shows only the configured repository.
4. Edit a noncritical test document and wait for Saved.
5. Verify the SHA-guarded commit in GitHub.
6. Change the same file remotely, use Pull, and verify the new version appears.
7. Exercise a conflict and confirm the local recovery revision remains
   available.
8. Restart the Render API during a desktop device flow and confirm Redis keeps
   the pending attempt.

## Coauthors

Owner Settings includes a **Sharing** section:

1. Add a principal with a display name.
2. Grant `reader`, `commenter`, or `editor` access to selected projects.
3. Create a time-limited one-use invitation.
4. Send the invitation link through a trusted channel.
5. Revoke unused invitations or sessions when access changes.

Projectless files and ungranted projects remain hidden. Coauthors use the hosted
web application and do not need GitHub accounts. Review the generated
`library-access.yaml` commit like any other authorization change.

## GitHub App versus AI connector

The MdLyx GitHub App is the server’s storage identity. The ChatGPT/Codex GitHub
connector is a separate AI integration with its own authorization. Neither
inherits the other’s permissions. See [AI-assisted workflows](AI_WORKFLOWS.md).

## Troubleshooting

- `configured: false`: check every required environment variable and the secret
  file path.
- `/ready` is false: verify `REDIS_URL`, private networking, and Key Value
  readiness.
- OAuth callback failure: compare the GitHub App callback and `APP_ORIGIN`
  character-for-character, including HTTPS and the absence of a trailing path.
- Repository not found: confirm the installation is scoped to the intended
  repository and the installation ID is correct.
- Owner rejected: compare `ALLOWED_GITHUB_LOGIN` with the authenticated login.
- Device code disappears after a restart: production must use
  `PENDING_DEVICE_STORE=redis`; memory mode is development-only.

See [Troubleshooting](TROUBLESHOOTING.md) for browser and library diagnostics.

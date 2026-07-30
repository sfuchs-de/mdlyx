# Security

Please do not open a public issue for a vulnerability that could expose files,
GitHub credentials, invitation tokens, or coauthor data. Use GitHub's private
vulnerability reporting feature for this repository.

Supported security fixes target the current `main` branch. Local-folder mode
does not upload documents. A self-hosted GitHub-sync deployment is responsible
for protecting its own secrets, Redis instance, GitHub App installation, and
allowed origins.

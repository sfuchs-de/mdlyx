# Desktop builds

MdLyx uses Tauri 2. The default public configuration is suitable for local
development and creates no updater artifacts.

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm run tauri:build
```

For a ready-made development build, download the universal DMG from the
[MdLyx Releases page](https://github.com/sfuchs-de/mdlyx/releases). It is ad-hoc
signed and not Apple-notarized, so macOS may require explicit approval in
System Settings. Verify the downloaded file against the release's
`SHA256SUMS` before opening it.

The public DMG does not silently update itself and contains no shared updater
key. Fork maintainers who want automatic updates must establish their own
application identifier, signing key, release feed, and trust policy. Never
reuse another deployment's updater key.

To enable desktop GitHub sync, set `VITE_LIBRARY_API_URL` when building and add
that exact HTTPS origin to `connect-src` in `src-tauri/tauri.conf.json`.

# Desktop builds

MdLyx uses Tauri 2. The default public configuration is suitable for local
development and creates no updater artifacts.

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm run tauri:build
```

On macOS, an unsigned local build may require explicit approval in System
Settings. Public distribution requires your own application identifier,
Developer ID signing, notarization, updater key, and release workflow. Never
reuse another deployment's updater key.

To enable desktop GitHub sync, set `VITE_LIBRARY_API_URL` when building and add
that exact HTTPS origin to `connect-src` in `src-tauri/tauri.conf.json`.

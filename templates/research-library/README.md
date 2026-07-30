# __PROJECT_TITLE__ research library

This is a local-first MdLyx research library. Its initial project key is
`__PROJECT_KEY__`, and its declared source authority is `__AUTHORITY__`.

## Start here

1. Open this folder from MdLyx’s **Library** panel.
2. Read `projects/__PROJECT_KEY__/index.md`.
3. Replace the bracketed drafting prompts with your own research material.
4. Preserve document IDs when moving or renaming files.
5. Validate the folder from an MdLyx source checkout:

```bash
npm run library:validate -- --root /path/to/this-library
```

No remote repository or hosted service is required. If this material is
confidential, keep the folder and any future Git remote private.

## Authority

- `mdlyx`: this library is the canonical research source.
- `external`: another manuscript or repository remains canonical.
- `split`: the provenance note identifies which source owns each part.

The generated provenance note records the selected mode. Review it before
importing existing research.

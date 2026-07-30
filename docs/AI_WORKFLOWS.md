# Use a research library with Codex or ChatGPT

AI assistance is most reliable when the model can see the project overview,
owner notes, provenance, verification manifest, and repository instructions
together. It should never infer scholarly validation from fluent prose.

## Recommended: local Codex

Open a local checkout of the research-library repository in Codex. The
initializer places `AGENTS.md` at the root; Codex reads repository-level
`AGENTS.md` before work and applies closer nested instructions later in the
directory tree.

The generated instructions require authority discovery, a change summary,
stable IDs, explicit validation evidence, and post-edit library validation.
Keep those rules short and update them when recurring review mistakes appear.

Official references:

- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex customization](https://learn.chatgpt.com/docs/customization/overview)

Local Codex already has filesystem and Git context supplied by the checkout. A
GitHub connector is not required for this route.

## Remote repository access

ChatGPT or Codex can use an authorized GitHub connector when the session must
inspect a repository remotely. Authorize only the repositories needed for the
task and follow workspace policy.

This connector does **not** configure MdLyx’s GitHub sync. The integrations are
separate:

- The MdLyx GitHub App lets your self-hosted API read and commit the library.
- The ChatGPT/Codex GitHub connector lets the AI access repositories allowed by
  its own authorization.

See the official [GitHub integration guide](https://learn.chatgpt.com/docs/third-party/github)
and [plugin documentation](https://learn.chatgpt.com/docs/plugins). Interface
names and availability can vary by product surface and workspace policy.

For structural changes, ask the AI to use a branch and prepare a pull request
instead of changing the protected branch directly.

## Selected file uploads

Uploading a document to ChatGPT is useful for an isolated explanation or prose
review. It does not provide repository-wide links, owner documents, dependency
context, or automatic synchronization. Supply the relevant provenance and
assumptions explicitly, and copy reviewed changes back into the canonical
library yourself.

## Safe prompt recipes

### Orient before editing

```text
Read AGENTS.md, the project overview, and the provenance note. State which
source is authoritative, identify the owner documents relevant to this request,
and summarize the proposed changes. Do not edit yet.
```

### Add a derivation

```text
Add a derivation note for [topic]. Preserve existing IDs and notation. Include
reader orientation, objects, assumptions, semantic derivation steps, checks,
failure conditions, and links to its prerequisites. Do not add or promote a
formal result unless the evidence supports the declared validation state.
```

### Audit claims

```text
Audit each formal result against its owner document, evidence, dependencies,
remaining condition, and source authority. Report discrepancies with file and
anchor references. Do not modify validation states.
```

### Check links and citations

```text
Run the general library validator. Repair only confirmed broken stable-ID links,
anchors, bibliography paths, and missing citation keys. Preserve authored
Markdown source and report anything ambiguous instead of guessing.
```

### Update the synthesis

```text
Update the project synthesis in dependency order using the owner documents.
Separate validated statements from partial or open conditions, link each major
step to its owner, and preserve the verification manifest unless separately
authorized.
```

### Prepare a reviewed change

```text
Review the diff, run library validation, summarize scholarly and structural
changes separately, identify unresolved diagnostics, and prepare a pull request.
Do not commit credentials, machine-specific paths, or recovery data.
```

## Review discipline

- Keep unpublished libraries private.
- Use least-privilege repository and connector access.
- Never paste private keys, session secrets, access tokens, or `.env` contents
  into a chat.
- Require independent evidence for changes to validation states.
- Review diffs for changed IDs, dependencies, bibliography keys, and
  provenance.
- Run `npm run library:validate -- --root <path>` after structural edits.
- Use pull requests for authority, result, dependency, or access-policy changes.

The public repository intentionally supplies guidance rather than a custom
plugin. A reusable skill may be appropriate later if the workflow stabilizes;
plugins are better suited to installable bundles that also need connectors or
tools.

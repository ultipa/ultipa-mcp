# Releasing

This package ships through two independent channels. Both are driven by a single
version bump in `package.json`.

## Channels

- **npm** — `@ultipa-graph/gqldb-mcp`, published manually (`npm publish`).
- **Anthropic MCP Directory** — pulls the `.mcpb` bundle attached to a GitHub
  Release. Anthropic publishes the *exact* `.mcpb` we attach (they do not rebuild
  from source), so the asset on the Release is what users install.

## Tag convention

```
gqldb-mcp-<version>      e.g. gqldb-mcp-1.1.0
```

The `.mcpb` asset filename matches the tag exactly: `gqldb-mcp-1.1.0.mcpb`.

## Release flow

1. Bump `"version"` in `package.json` (and update any changelog).
2. Commit: `git commit -am "Release v1.1.0"`.
3. Tag and push:
   ```bash
   git tag gqldb-mcp-1.1.0
   git push origin main --tags
   ```
4. The **Release MCPB** workflow (`.github/workflows/release-mcpb.yml`) then:
   - verifies the tag version matches `package.json` (fails the run if not),
   - runs `npm run build:mcpb` (validates the manifest, packs `gqldb-mcp-1.1.0.mcpb`),
   - creates the GitHub Release and attaches the bundle.
5. (npm) `npm publish` when ready — independent of the tag above.

The workflow can also be re-run for an existing tag via **Actions → Release MCPB →
Run workflow**, passing the tag name.

## Local bundle build

`npm run build:mcpb` produces `gqldb-mcp.mcpb` at the repo root for manual testing
(drag into Claude Desktop). Override the output path with `MCPB_OUT=/path/to/x.mcpb`.

## Registering with Anthropic (one-time)

The directory channel is pull-based — once registered, new tags are picked up
automatically with no per-release submission. Report to Anthropic:

- **owner/repo:** `ultipa/gqldb-mcp`
- **tag pattern:** `gqldb-mcp-*` (semver, e.g. `gqldb-mcp-1.1.0`)
- **asset:** `.mcpb` attached to the GitHub Release, filename matching the tag.

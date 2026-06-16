# Security Policy

## Supported Versions

The latest published release on npm receives security updates. Older versions are not patched.

## Reporting a Vulnerability

If you find a security issue in Ultipa MCP, please report it privately:

- Email: support@ultipa.com
- Or open a [private security advisory](https://github.com/ultipa/ultipa-mcp/security/advisories/new) on GitHub.

Please include:

- A short description of the issue and its impact
- Steps to reproduce (a minimal proof of concept where possible)
- The affected version(s)

We aim to acknowledge reports within 3 business days and ship a fix as soon as is reasonable. Please give us a chance to release the fix before disclosing publicly.

## What's in scope

- The MCP server code in this repository
- Bundled dependencies (when the vulnerability is exposed via this package's surface)

## What's out of scope

- Vulnerabilities in Ultipa Cloud or GQLDB itself — report those to `security@ultipa.com` directly
- Vulnerabilities in third-party MCP clients (Claude Desktop, Cursor, etc.) — report to the respective vendor
- Misconfiguration on the user's side (e.g., committing `ULTIPA_CLOUD_API_KEY` to a public repo)

# Ultipa MCP

Model Context Protocol server for [Ultipa Cloud](https://dbaas.ultipa.com) and any self-managed Ultipa GQLDB instance. Lets MCP clients provision and operate instances, run GQL queries, manage backups, view metrics, and more, all through natural language.

## Auth

Each MCP server entry in your client's config points at one Ultipa target via one of two paths:

| Path | Use it if | Env vars |
|---|---|---|
| **Ultipa Cloud** | You manage instances via [Ultipa Cloud](https://dbaas.ultipa.com). | `ULTIPA_CLOUD_API_KEY` (create at https://dbaas.ultipa.com → Settings → API Keys) |
| **Direct instance** | You have admin credentials to a single GQLDB instance. | `ULTIPA_HOST` + `ULTIPA_USERNAME` + `ULTIPA_PASSWORD`, optional `ULTIPA_GRAPH` |

Need both, or multiple direct instances? Add more entries (see [Multiple targets](#multiple-targets)).

**Ultipa Cloud API key scopes** depend on which tools you'll use:

| Scope | What it unlocks |
|---|---|
| `instances:read` | All read tools (list, get, metrics, …) |
| `instances:write` | State changes (create, pause, restart, upgrade, set log level, schedule backups, …) |
| `instances:delete` | `delete_instance`, `delete_backup` |
| `instances:credentials` | `get_instance_credentials`. Also required by the data-plane tools under Ultipa Cloud account mode, because they fetch credentials per call. |
| `billing:read`, `billing:write` | The billing tools |

## Install

### One target via install-mcp

Replace `claude` with your client: `cursor`, `windsurf`, `vscode`, `cline`, etc.

For an Ultipa Cloud account:

```bash
npx -y install-mcp@latest ultipa-mcp --client claude \
  --env ULTIPA_CLOUD_API_KEY=uc_...
```

For a direct instance:

```bash
npx -y install-mcp@latest ultipa-mcp --client claude \
  --env ULTIPA_HOST=host:60061 \
  --env ULTIPA_USERNAME=admin \
  --env ULTIPA_PASSWORD=... \
  --env ULTIPA_GRAPH=default
```

### Multiple targets

Each MCP server entry in your client's config points at one Ultipa target. Add as many entries as you need, with descriptive names. Claude (or any agent) sees each entry as its own toolset and picks based on what you ask (e.g. "query staging" routes to the `ultipa-staging` entry).

The same JSON shape works in any stdio MCP client; only the file path differs (Claude Desktop: `claude_desktop_config.json` via Settings → Developer → Edit Config; Cursor: `~/.cursor/mcp.json`; Windsurf, VS Code MCP extensions: see their docs).

```json
{
  "mcpServers": {
    "ultipa-cloud": {
      "command": "npx",
      "args": ["-y", "ultipa-mcp"],
      "env": {
        "ULTIPA_CLOUD_API_KEY": "uc_..."
      }
    },
    "ultipa-staging": {
      "command": "npx",
      "args": ["-y", "ultipa-mcp"],
      "env": {
        "ULTIPA_HOST": "staging.internal:60061",
        "ULTIPA_USERNAME": "admin",
        "ULTIPA_PASSWORD": "..."
      }
    },
    "ultipa-prod": {
      "command": "npx",
      "args": ["-y", "ultipa-mcp"],
      "env": {
        "ULTIPA_HOST": "prod.internal:60061",
        "ULTIPA_USERNAME": "admin",
        "ULTIPA_PASSWORD": "..."
      }
    }
  }
}
```

Restart your client after editing.

## Tools

### Account

| Tool | What it does |
|---|---|
| `get_account` | Authenticated account profile (email, name, balance flags). |

### Instance lifecycle

| Tool | What it does |
|---|---|
| `list_instances` | List all instances on the account. |
| `get_instance` | Fetch one instance by ID. |
| `list_deleted_instances` | List deleted instances (not returned by `list_instances`). |
| `create_instance` | Provision a new instance (name, region, sizeId). |
| `rename_instance` | Change an instance's display name. |
| `pause_instance` | Pause a running instance. |
| `resume_instance` | Resume a paused instance. |
| `restart_instance` | Restart the instance. |
| `upgrade_version` | Upgrade to the latest GQLDB version. |
| `delete_instance` | Delete an instance. Requires the instance name as confirmation. |
| `get_instance_credentials` | Fetch admin username and password of the instance. |
| `reset_admin_password` | Rotate the admin DB password. Breaks existing connections. |
| `list_regions` | List supported regions and their Manager URLs. |
| `list_instance_sizes` | List available sizes and pricing. |
| `get_latest_version` | Latest available GQLDB version. |
| `get_trial_status` | Free-trial eligibility. Pre-check before creating a free-trial instance. |
| `get_enterprise_status` | Enterprise-tier eligibility. Pre-check before creating an enterprise instance. |
| `get_operations_lock` | Whether instance ops are globally locked (maintenance / freeze). |
| `wait_for_instance_status` | Explicit polling helper. Rarely needed. |

### Metrics & Logs

| Tool | What it does |
|---|---|
| `get_live_metrics` | Current CPU / memory / disk / network snapshot. |
| `get_metrics_history` | Historical metrics over the last N minutes (default 60, max 14 days). |
| `get_instance_logs` | Recent container logs (default 100 lines, max 1000). |
| `set_log_level` | Set GQLDB log level (debug / info / warn / error). |

### Alerts

| Tool | What it does |
|---|---|
| `list_alerts` | All alerts across the account's instances. |
| `list_instance_alerts` | Alerts for a single instance. |

### Firewall

| Tool | What it does |
|---|---|
| `get_my_ip` | Public IP of the machine running Ultipa MCP (pair with `add_firewall_rule` to allow `${ip}/32`). |
| `list_firewall_rules` | IP-allowlist rules for an instance. |
| `add_firewall_rule` | Add a CIDR to the allowlist. |
| `remove_firewall_rule` | Remove a rule by its CIDR. |

### Backups

| Tool | What it does |
|---|---|
| `list_backups` | List backups for an instance. |
| `create_backup` | Trigger an on-demand backup (default 10-min timeout). |
| `restore_backup` | Restore from a completed backup. **Destructive: overwrites current data.** |
| `delete_backup` | Permanently delete a backup snapshot. |
| `set_backup_schedule` | Set/update an automated backup schedule. |
| `clear_backup_schedule` | Remove the schedule (existing backups kept). |

### Billing

| Tool | What it does |
|---|---|
| `get_balance` | Current account balance and billing flags. |
| `list_transactions` | Balance transactions (top-ups, charges, refunds). |
| `get_usage` | Monthly usage-based billing summary. |
| `get_payment_method` | Saved card info. |
| `get_auto_reload` | Current auto-reload settings. |
| `set_auto_reload` | Update auto-reload settings. |
| `topup_balance` | Top up balance with a saved card. |
| `start_payment_method_setup` | Stripe Checkout URL for adding/changing the saved card. |

### Data plane

| Tool | What it does |
|---|---|
| `test_connection` | Quick health check on the target GQLDB instance. |
| `run_gql_query` | Execute a GQL query and return results. |
| `explain_query` | Return the execution plan without running the query. |
| `run_algo` | Run a built-in graph algorithm. Centrality, community detection, similarity, pathfinding, graph embeddings, etc. Same execution as `run_gql_query`; separate so the agent surfaces the algorithm catalog for analytical questions. |
| `list_graphs` | List all graphs on the instance. |
| `describe_schema` | Detect graph mode (OPEN / CLOSED / ONTOLOGY) and run the right schema introspection. |
| `create_graph` | Create a new graph (OPEN / CLOSED / ONTOLOGY). |
| `delete_graph` | Drop a graph. **Destructive — wipes all nodes, edges, indices.**  |
| `write_data` | Run a GQL DML statement the agent composes by hand. For files on the user's machine, use `import_data` instead. |
| `import_data` | Bulk-write structured nodes / edges via the driver's gRPC bulk-insert path. **Two input modes**: **CSV pass-through** (pass raw CSV as `csv` + `csvLabel` + column mappings — much faster on big CSVs since the agent emits the file verbatim instead of generating row JSON) or **canonical arrays** (`nodes` / `edges` for non-CSV formats: JSON, JSONL, GraphML, pasted text). |
| `write_procedure` | Create a stored procedure. |
| `get_db_version` | Live GQLDB version reported by the instance. |
| `get_db_license` | GQLDB Edition + license info. |
| `reload_db_stats` | Rebuild the instance's stored statistics. |

### Docs

| Tool | What it does |
|---|---|
| `lookup_docs` | Fetch Ultipa documentation pages by topic. Useful for the agent to ground GQLDB features and GQL composition in authoritative reference. |

## Local development

```bash
npm install
npm run dev      # tsx watch
```

To point your local MCP client at the dev build, replace `command` / `args` in the JSON above with:

```json
"command": "/absolute/path/to/ultipa-mcp/node_modules/.bin/tsx",
"args": ["/absolute/path/to/ultipa-mcp/src/index.ts"]
```

Both paths must be absolute. MCP clients launch the server from `/`, not your project directory.

To check types: `npx tsc --noEmit`. To produce a publishable build: `npm run build` (outputs to `dist/`).

## License

ISC

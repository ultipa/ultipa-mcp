# Ultipa MCP

Model Context Protocol server for [Ultipa Cloud](https://dbaas.ultipa.com) and any self-managed Ultipa GQLDB instance. Lets MCP clients provision and operate instances, run GQL queries, manage backups, view metrics, and more, all through natural language.

## Auth

Configure either or both:

| | Use it if | Needs |
|---|---|---|
| **Ultipa Cloud account** | You manage instances via [Ultipa Cloud](https://dbaas.ultipa.com). | `ULTIPA_CLOUD_API_KEY` (create at https://dbaas.ultipa.com → Settings → API Keys) |
| **Direct instance** | You have admin credentials to a single GQLDB instance. | `ULTIPA_HOST` + `ULTIPA_USERNAME` + `ULTIPA_PASSWORD`, optional `ULTIPA_GRAPH` |

If neither is set, the server exits at startup with a clear error.

**Ultipa Cloud API key scopes** depend on which tools you'll use:

| Scope | What it unlocks |
|---|---|
| `instances:read` | All read tools (list, get, metrics, …) |
| `instances:write` | State changes (create, pause, restart, upgrade, set log level, schedule backups, …) |
| `instances:delete` | `delete_instance`, `delete_backup` |
| `instances:credentials` | `get_instance_credentials`. Also required by the data-plane tools under Ultipa Cloud account mode, because they fetch credentials per call. |
| `billing:read` / `billing:write` | The billing tools |

## Installation

### Quick install (recommended)

Pick the command that matches what you configured above. Replace `claude` with your client: `cursor`, `windsurf`, `vscode`, `cline`, etc.

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

For both:

```bash
npx -y install-mcp@latest ultipa-mcp --client claude \
  --env ULTIPA_CLOUD_API_KEY=uc_... \
  --env ULTIPA_HOST=host:60061 \
  --env ULTIPA_USERNAME=admin \
  --env ULTIPA_PASSWORD=... \
  --env ULTIPA_GRAPH=default
```

### Manual configuration

Works for any stdio MCP client (Claude Desktop, Cursor, Windsurf, VS Code MCP extensions, etc.); only the config file path differs. Example for Claude Desktop: open `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "ultipa": {
      "command": "npx",
      "args": ["-y", "ultipa-mcp"],
      "env": {
        "ULTIPA_CLOUD_API_KEY": "uc_..."
      }
    }
  }
}
```

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
| `list_instance_sizes` | List available sizes and pricing (optional `tier`/`region` filters). |
| `get_latest_version` | Latest available GQLDB version. |
| `get_trial_status` | Free-trial eligibility (`canCreateTrial`, etc.). Pre-check before creating a free-trial instance. |
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
| `get_my_ip` | Public IP of the machine running `ultipa-mcp` (pair with `add_firewall_rule` to allow `${ip}/32`). |
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
| `get_usage` | Monthly usage-based billing summary (optional `month` arg). |
| `get_payment_method` | Saved card info, or `null` if none. |
| `get_auto_reload` | Current auto-reload settings. |
| `set_auto_reload` | Update auto-reload (`enabled`, `thresholdCents`, `targetCents`). |
| `topup_balance` | Top up balance. With a saved card and no 3DS, credits immediately; otherwise returns a `clientSecret`. |
| `start_payment_method_setup` | Stripe Checkout URL for adding/changing the saved card. |

### Data plane

| Tool | What it does |
|---|---|
| `test_connection` | Quick health check on the target GQLDB instance (`healthCheck()` plus latency). |
| `run_gql_query` | Execute a GQL query and return rows. |
| `explain_query` | Return the execution plan without running the query. |
| `list_graphs` | List all graphs on the instance. |
| `describe_schema` | Schema introspection. Detects `graph_mode` (OPEN / CLOSED / ONTOLOGY) and runs the right introspection statements. |
| `get_db_version` | Live GQLDB version reported by the instance (`db.version()`). |
| `get_db_license` | Edition + license info (`db.license()`). |
| `reload_db_stats` | Rebuild the instance's stored statistics (`db.reload_stats()`). |

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

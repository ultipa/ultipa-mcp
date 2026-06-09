#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasModeA, hasModeB } from "./helpers/env.js";
import { closeAllDataPlaneClients } from "./helpers/dataplane.js";
import { registerAccountTools } from "./tools/account.js";
import { registerInstanceTools } from "./tools/instances.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerLogTools } from "./tools/logs.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerFirewallTools } from "./tools/firewall.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerBackupTools } from "./tools/backups.js";
import { registerDataPlaneTools } from "./tools/dataplane.js";

// ── Fail-fast — neither mode configured ──────────────────────────────────
if (!hasModeA && !hasModeB) {
  console.error(
    [
      "ultipa-mcp needs at least one auth mode configured:",
      "",
      "  Mode A (control plane — instances, billing, etc.):",
      "    ULTIPA_CLOUD_API_KEY=uc_...",
      "    Get a key at https://dbaas.ultipa.com → Settings → API Keys.",
      "",
      "  Mode B (data plane — run GQL against one instance):",
      "    ULTIPA_HOST=host:port",
      "    ULTIPA_USERNAME=...",
      "    ULTIPA_PASSWORD=...",
      "    ULTIPA_GRAPH=...   (optional default graph)",
      "",
      "Either or both can be set. Set them in your MCP client's server config under `env`, or export them in the shell that launches the server.",
    ].join("\n"),
  );
  process.exit(1);
}

// ── Cleanup data-plane gRPC connections on shutdown ──────────────────────
process.on("SIGINT", () => {
  closeAllDataPlaneClients().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  closeAllDataPlaneClients().finally(() => process.exit(0));
});

// ── Server setup ─────────────────────────────────────────────────────────
const server = new McpServer(
  { name: "ultipa-mcp", version: "0.0.1" },
  {
    instructions: [
      "Ultipa Cloud manages GQLDB instances. When the user asks how to connect to or use a running instance, refer only to the options below — do not invent product names.",
      "",
      "**Two paths to a GQLDB instance — keep them straight.**",
      "1. **Cloud-managed instances** (Mode A). Discoverable via `list_instances`. State-change tools (create / pause / delete / etc.) operate on these. To run a query against one of these instances, call a data-plane tool (`run_gql_query`, `list_graphs`, `describe_schema`, `get_db_version`, …) and pass its `_id` as the `id` arg.",
      "2. **A directly-configured instance** (Mode B) — the user has set `ULTIPA_HOST` + `ULTIPA_USERNAME` + `ULTIPA_PASSWORD` in this MCP's env. It is NOT returned by `list_instances` (that endpoint only sees Cloud instances). To reach it, call a data-plane tool WITHOUT an `id` arg — the MCP routes the call to the env-configured instance.",
      "",
      "If a data-plane tool is registered at all, a target exists. So 'I can't see your local instance' is wrong if the data-plane tools are in your toolset — call `test_connection` (omit `id`) to get a yes/no reachability answer instead of guessing.",
      "",
      "Ways to connect (all need the instance's `host`, `port`, `adminUser`, `adminPassword)",
      "- Ultipa Manager: open the instance's `managerUrl` in a browser. Easiest first-touch — gives a query editor, schema view, metrics, etc. with clear UI. First time connecting to an instance, user needs to add a connection.",
      "- Official SDKs:",
      "  - Python: https://www.ultipa.com/docs/drivers/python-quick-start",
      "  - Java: https://www.ultipa.com/docs/drivers/java-quick-start",
      "  - Go: https://www.ultipa.com/docs/drivers/go-quick-start",
      "  - Node.js / TypeScript: https://www.ultipa.com/docs/drivers/nodejs-quick-start",
      "- Ultipa CLI: a standalone binary for running queries from a terminal, download and learn more from https://www.ultipa.com/docs/tools/cli.",
      "",
      "The query language is GQL (the ISO standard graph query language). Do not refer to it as UQL, and do not mention a 'UQL Shell' or 'UQL CLI' — neither exists.",
      "",
      "The `adminPassword` is NOT returned by `create_instance`, `list_instances`, or `get_instance`. To fetch it, call `get_instance_credentials` (requires the API key to have the `instances:credentials` scope; audit-logged). After a successful `create_instance`, immediately call `get_instance_credentials` and surface the password to the user — that's how they get the initial password.",
      "",
      "If `get_instance_credentials` fails on permissions/scope, the recovery options are: (1) view the password at https://dbaas.ultipa.com → instance detail page, (2) regenerate the API key with the `instances:credentials` scope enabled and reconnect, or (3) only when the user explicitly asks to rotate the password, call `reset_admin_password`. Do NOT suggest logging into the instance's Manager UI to recover the password, that UI requires the password to log in.",
    ].join("\n"),
  },
);

// ── Mode A — Cloud control plane tools ───────────────────────────────────
if (hasModeA) {
  registerAccountTools(server);
  registerInstanceTools(server);
  registerMetricsTools(server);
  registerLogTools(server);
  registerAlertTools(server);
  registerFirewallTools(server);
  registerBillingTools(server);
  registerBackupTools(server);
}

// ── Data plane — Mode B alone, or Mode A with `id` ───────────────────────
if (hasModeA || hasModeB) {
  registerDataPlaneTools(server);
}

const transport = new StdioServerTransport();
await server.connect(transport);

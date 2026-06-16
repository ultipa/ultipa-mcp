#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEBUG,
  INSTANCE_HOST,
  INSTANCE_PASSWORD,
  INSTANCE_USER,
  hasModeA,
  hasModeB,
} from "./helpers/env.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
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
import { registerDocsTools } from "./tools/docs.js";

// Read package version at runtime so it stays in sync with package.json.
// Works in both dev (tsx, file at src/index.ts) and prod (dist/index.js) since
// package.json sits two levels up from either.
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ── Fail-fast — neither mode configured, OR Direct mode partially configured ─
const partialDirect =
  !hasModeB && (!!INSTANCE_HOST || !!INSTANCE_USER || !!INSTANCE_PASSWORD);
if (!hasModeA && (!hasModeB || partialDirect)) {
  const lines: string[] = [];
  if (partialDirect) {
    const missing: string[] = [];
    if (!INSTANCE_HOST) missing.push("ULTIPA_HOST");
    if (!INSTANCE_USER) missing.push("ULTIPA_USERNAME");
    if (!INSTANCE_PASSWORD) missing.push("ULTIPA_PASSWORD");
    lines.push(
      `Direct instance config is incomplete — missing: ${missing.join(", ")}.`,
      "All three of ULTIPA_HOST, ULTIPA_USERNAME, ULTIPA_PASSWORD are required for Direct mode.",
      "",
    );
  }
  lines.push(
    "Ultipa MCP needs at least one auth mode configured:",
    "",
    "  Ultipa Cloud (manage instances and run GQL against any instance on the account):",
    "    ULTIPA_CLOUD_API_KEY=uc_...",
    "    Get a key at https://dbaas.ultipa.com → Settings → API Keys.",
    "",
    "  Direct instance (run GQL against one specific GQLDB instance, no Cloud account needed):",
    "    ULTIPA_HOST=host:port",
    "    ULTIPA_USERNAME=...",
    "    ULTIPA_PASSWORD=...",
    "    ULTIPA_GRAPH=...   (optional default graph)",
    "",
    "Either or both can be set. Set them in your MCP client's server config under `env`, or export them in the shell that launches the server.",
  );
  console.error(lines.join("\n"));
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
  { name: "ultipa-mcp", version: PKG_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

// ── ULTIPA_MCP_DEBUG=1: log every tool call name + latency to stderr ─────
// Wrap server.tool() so every registered tool's handler is instrumented. Only
// installed when DEBUG is on, so the default path stays free of overhead.
if (DEBUG) {
  const originalTool = server.tool.bind(server);
  (server as any).tool = (...args: any[]) => {
    const handlerIdx = args.length - 1;
    const handler = args[handlerIdx];
    if (typeof handler === "function") {
      const name = args[0] as string;
      args[handlerIdx] = async (...callArgs: any[]) => {
        const start = Date.now();
        try {
          const result = await handler(...callArgs);
          console.error(`[ultipa-mcp] ${name} ok ${Date.now() - start}ms`);
          return result;
        } catch (e: any) {
          console.error(
            `[ultipa-mcp] ${name} err ${Date.now() - start}ms ${e?.message ?? String(e)}`,
          );
          throw e;
        }
      };
    }
    return originalTool(...(args as Parameters<typeof originalTool>));
  };
}

// ── Ultipa Cloud tools (control plane) ───────────────────────────────────
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

// ── Data-plane tools + GQL docs lookup ───────────────────────────────────
// Both gated by the same guard: lookup_docs is only useful when the
// agent can actually compose and run queries, which requires a data-plane
// target (either Direct instance or Ultipa Cloud with `id`).
if (hasModeA || hasModeB) {
  registerDataPlaneTools(server);
  registerDocsTools(server);
}

const transport = new StdioServerTransport();
await server.connect(transport);

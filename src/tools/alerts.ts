import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";

export function registerAlertTools(server: McpServer) {
  server.tool(
    "list_alerts",
    "List all alerts across the account's instances.",
    {},
    async () => json(await api("/v1/instances/alerts")),
  );

  server.tool(
    "list_instance_alerts",
    "List alerts for a single instance (all statuses).",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}/alerts`)),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { api, json } from "../helpers/api.js";

export function registerAccountTools(server: McpServer) {
  server.tool(
    "get_account",
    "Get the authenticated account's profile (email, name, balance flags, billing-related metadata). Useful as a 'who am I?' check or to surface account-wide info to the user.",
    {},
    async () => json(await api("/v1/account")),
  );
}

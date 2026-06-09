import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";

export function registerLogTools(server: McpServer) {
  server.tool(
    "get_instance_logs",
    "Fetch recent container logs from a GQLDB instance. Default 100 lines, max 1000.",
    {
      id: z.string().describe("The instance ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Max number of log lines to return (1–1000). Default 100."),
    },
    async ({ id, limit }) =>
      json(await api(`/v1/instances/${id}/logs?limit=${limit}`)),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";

export function registerMetricsTools(server: McpServer) {
  server.tool(
    "get_live_metrics",
    "Current snapshot of an instance's metrics (CPU, memory, disk, network). Single point-in-time reading; use `get_metrics_history` for a time series.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}/metrics`)),
  );

  server.tool(
    "get_metrics_history",
    "Historical metrics for an instance over the last N minutes. Default 60, max 20160 (14 days).",
    {
      id: z.string().describe("The instance ID"),
      range: z
        .number()
        .int()
        .min(1)
        .max(20160)
        .default(60)
        .describe("Lookback window in minutes (1–20160). Default 60."),
    },
    async ({ id, range }) =>
      json(await api(`/v1/instances/${id}/metrics/history?range=${range}`)),
  );
}

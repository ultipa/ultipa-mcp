import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";

export function registerFirewallTools(server: McpServer) {
  server.tool(
    "get_my_ip",
    "Return the public IP of the machine running this MCP server (as seen by Ultipa Cloud). Useful before `add_firewall_rule` — pass `${ip}/32` as the CIDR to allow just this machine. Note: with stdio transport (the current setup), the MCP server runs on the user's machine, so this is effectively the user's outbound IP. A future hosted MCP would return the hosting server's IP instead.",
    {},
    async () => json(await api("/v1/instances/my-ip")),
  );

  server.tool(
    "list_firewall_rules",
    "List the IP-allowlist (firewall) rules for an instance. Only applies to instances where `firewallSupported` is true (EC2-backed); free-trial / docker-host instances don't have firewalls.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}/firewall-rules`)),
  );

  server.tool(
    "add_firewall_rule",
    "Add a CIDR to the instance's IP allowlist. Use `0.0.0.0/0` to allow all (NOT recommended for production). Synchronous.",
    {
      id: z.string().describe("The instance ID"),
      cidr: z
        .string()
        .describe(
          "CIDR block to allow, e.g. '203.0.113.42/32' for a single IP or '10.0.0.0/8' for a range",
        ),
      description: z
        .string()
        .optional()
        .describe("Optional human-readable note for this rule"),
    },
    async ({ id, cidr, description }) => {
      const body: Record<string, unknown> = { cidr };
      if (description !== undefined) body.description = description;
      return json(
        await api(`/v1/instances/${id}/firewall-rules`, {
          method: "POST",
          body,
        }),
      );
    },
  );

  server.tool(
    "remove_firewall_rule",
    "Remove a firewall rule by its CIDR. The CIDR must match an existing rule exactly. Synchronous.",
    {
      id: z.string().describe("The instance ID"),
      cidr: z
        .string()
        .describe("CIDR of the rule to remove (must match an existing rule)"),
    },
    async ({ id, cidr }) => {
      await api(`/v1/instances/${id}/firewall-rules`, {
        method: "DELETE",
        body: { cidr },
      });
      return json({ removed: true, id, cidr });
    },
  );
}

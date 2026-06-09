import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HealthStatus, type QueryConfig } from "@ultipa-graph/ultipa-driver";
import { json } from "../helpers/api.js";
import {
  getDataPlaneClient,
  resolveDataPlaneTarget,
  serializeResponse,
} from "../helpers/dataplane.js";
import {
  DEFAULT_GRAPH,
  INSTANCE_HOST,
  hasModeA,
  hasModeB,
} from "../helpers/env.js";

export function registerDataPlaneTools(server: McpServer) {
  // Conditional `id` arg: required under Mode A only, optional under both modes,
  // absent under Mode B only.
  const idArg: Record<string, z.ZodTypeAny> = hasModeA
    ? {
        id: z
          .string()
          .optional()
          .describe(
            hasModeB
              ? `Instance ID. Omit to target the Mode B instance (ULTIPA_HOST${INSTANCE_HOST ? ` = ${INSTANCE_HOST}` : ""}). Pass any other instance ID to route via Mode A.`
              : "Instance ID. Required — Mode B is not configured, so there's no default target.",
          ),
      }
    : {};

  const graphArg = {
    graph: z
      .string()
      .optional()
      .describe(
        `Target graph name. ${DEFAULT_GRAPH ? `Defaults to ULTIPA_GRAPH = "${DEFAULT_GRAPH}"` : "No default configured (set ULTIPA_GRAPH or pass this arg)"}.`,
      ),
  };

  server.tool(
    "run_gql_query",
    "Execute a literal GQL query against a GQLDB instance and return the result rows. Reuses an open gRPC connection per instance (lazy-init on first call, closed on server shutdown). For Mode A targets, fetches credentials via `get_instance_credentials` on first connect — that API key needs the `instances:credentials` scope.",
    {
      ...idArg,
      query: z.string().min(1).describe("The GQL query to run"),
      ...graphArg,
    },
    async (args: { id?: string; query: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const cfg: QueryConfig = {};
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (graphName) cfg.graphName = graphName;
      const response = await client.gql(args.query, cfg);
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "explain_query",
    "Return the execution plan for a GQL query without running it. Same connection model as `run_gql_query`.",
    {
      ...idArg,
      query: z.string().min(1).describe("The GQL query to explain"),
      ...graphArg,
    },
    async (args: { id?: string; query: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const cfg: QueryConfig = {};
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (graphName) cfg.graphName = graphName;
      const plan = await client.explain(args.query, cfg);
      return json({ plan });
    },
  );

  server.tool(
    "test_connection",
    "Quick health check on the target GQLDB instance — call this when the user asks 'can you see my instance' / 'is my GQLDB reachable'. Resolves the target (Mode A: fetches creds via Cloud; Mode B: uses env vars), opens or reuses a gRPC connection, logs in, and runs `healthCheck()`. Returns `{ ok, target, status, latencyMs, error? }`. Much faster than running a real query — use this as the first probe.",
    { ...idArg },
    async (args: { id?: string }) => {
      const start = Date.now();
      let target: string;
      try {
        target = resolveDataPlaneTarget(args.id);
      } catch (e: any) {
        return json({
          ok: false,
          target: null,
          latencyMs: Date.now() - start,
          error: e?.message ?? String(e),
        });
      }
      try {
        const client = await getDataPlaneClient(target);
        const status = await client.healthCheck();
        return json({
          ok: status === HealthStatus.SERVING,
          target,
          status: HealthStatus[status] ?? String(status),
          latencyMs: Date.now() - start,
        });
      } catch (e: any) {
        return json({
          ok: false,
          target,
          latencyMs: Date.now() - start,
          error: e?.message ?? String(e),
        });
      }
    },
  );

  server.tool(
    "get_db_version",
    "Return the live GQLDB version reported by the instance itself (runs `RETURN db.version()`). Use this when you want ground truth — the Cloud control plane's `get_instance.version` field is what Ultipa Cloud *believes* the instance runs (from metadata), which can briefly diverge during/after an upgrade. Mode B users can only get the version this way.",
    { ...idArg },
    async (args: { id?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const response = await client.gql("RETURN db.version()");
      // db.version() returns a single-row, single-column scalar — surface it cleanly.
      let version: string | undefined;
      try {
        version = (response as any).singleString?.();
      } catch {
        /* fall back to serialized response below */
      }
      return json(
        version !== undefined ? { version } : serializeResponse(response),
      );
    },
  );

  server.tool(
    "get_db_license",
    "Return the instance's edition and license info (runs `RETURN db.license()`). Useful for confirming the running edition (Community / Enterprise / etc.), license expiry, and any feature flags tied to the license.",
    { ...idArg },
    async (args: { id?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const response = await client.gql("RETURN db.license()");
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "reload_db_stats",
    "Rebuild the instance's stored statistics by running `RETURN db.reload_stats()`. Use when the stats look stale or wrong (e.g. after a bulk import, or if `describe_schema`'s `stats` field looks off). Side effect: can be heavy on large datasets — avoid calling mid-traffic on a busy production instance unless you have to.",
    { ...idArg },
    async (args: { id?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const response = await client.gql("RETURN db.reload_stats()");
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "list_graphs",
    "List all graphs available on the target GQLDB instance (returns the SDK's `GraphInfo[]` — name, type, node/edge counts, etc.).",
    { ...idArg },
    async (args: { id?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      return json(await client.listGraphs());
    },
  );

  server.tool(
    "describe_schema",
    "Return the schema of a graph in one shot. Step 1 runs `DESC GRAPH <graph>` to detect the graph's `graph_mode` (OPEN | CLOSED | ONTOLOGY). Step 2 always runs `RETURN db.overview()` (mode-independent holistic view). Step 3 runs the mode-specific introspection: CLOSED → `SHOW NODE TYPES` + `SHOW EDGE TYPES` + `RETURN db.stats()` (labels & properties are defined with each node/edge type); OPEN → `RETURN db.stats()` (labels & properties are free-form, surfaced via stats); ONTOLOGY → `SHOW ONTOLOGY` + `SHOW PREFIX` + `SHOW CLASSES` + `SHOW PROPERTIES`. Lets the agent learn the schema in a single tool call regardless of graph kind.",
    {
      ...idArg,
      ...graphArg,
    },
    async (args: { id?: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (!graphName) {
        throw new Error(
          "describe_schema needs a graph name. Pass the `graph` arg or set ULTIPA_GRAPH.",
        );
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(graphName)) {
        throw new Error(
          `Graph name "${graphName}" must match [a-zA-Z_][a-zA-Z0-9_]*. Rename the graph or escape it manually via run_gql_query.`,
        );
      }
      const cfg: QueryConfig = { graphName };

      const safe = async (query: string) => {
        try {
          return serializeResponse(await client.gql(query, cfg));
        } catch (e: any) {
          return { error: e?.message ?? String(e) };
        }
      };

      // Step 1: detect graph mode via DESC GRAPH.
      let mode: string | undefined;
      const describeGraph = await safe(`DESC GRAPH ${graphName}`);
      const firstRow = (describeGraph as any)?.rows?.[0];
      if (firstRow && typeof firstRow === "object") {
        const v = firstRow.graph_mode ?? firstRow.GRAPH_MODE ?? firstRow.mode;
        if (v !== undefined && v !== null) mode = String(v).toUpperCase();
      }

      // Step 2: `db.overview()` works for any mode — fire it now, await with the rest.
      const overviewPromise = safe("RETURN db.overview()");

      // Step 3: branch on mode and run the mode-appropriate introspection.
      const out: Record<string, any> = { graph: graphName, mode, describeGraph };

      if (mode === "CLOSED") {
        const [overview, nodeTypes, edgeTypes, stats] = await Promise.all([
          overviewPromise,
          safe("SHOW NODE TYPES"),
          safe("SHOW EDGE TYPES"),
          safe("RETURN db.stats()"),
        ]);
        Object.assign(out, { overview, nodeTypes, edgeTypes, stats });
      } else if (mode === "OPEN") {
        const [overview, stats] = await Promise.all([
          overviewPromise,
          safe("RETURN db.stats()"),
        ]);
        Object.assign(out, { overview, stats });
      } else if (mode === "ONTOLOGY") {
        const [overview, ontology, prefix, classes, properties] = await Promise.all([
          overviewPromise,
          safe("SHOW ONTOLOGY"),
          safe("SHOW PREFIX"),
          safe("SHOW CLASSES"),
          safe("SHOW PROPERTIES"),
        ]);
        Object.assign(out, { overview, ontology, prefix, classes, properties });
      } else {
        // Couldn't extract graph_mode — fall back to running everything safely.
        out.note =
          "graph_mode not found in DESC GRAPH output; running generic introspection.";
        const [overview, nodeTypes, edgeTypes, labels, stats] = await Promise.all([
          overviewPromise,
          safe("SHOW NODE TYPES"),
          safe("SHOW EDGE TYPES"),
          safe("SHOW LABELS"),
          safe("RETURN db.stats()"),
        ]);
        Object.assign(out, { overview, nodeTypes, edgeTypes, labels, stats });
      }

      return json(out);
    },
  );
}

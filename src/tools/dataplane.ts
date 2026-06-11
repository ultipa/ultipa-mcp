import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HealthStatus,
  InsertType,
  type EdgeData,
  type NodeData,
  type QueryConfig,
} from "@ultipa-graph/ultipa-driver";
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
  // Conditional `id` arg: required under Ultipa Cloud only, optional when a Direct
  // instance is also configured, absent under Direct-only.
  const idArg: Record<string, z.ZodTypeAny> = hasModeA
    ? {
        id: z
          .string()
          .optional()
          .describe(
            hasModeB
              ? `Instance ID. Omit to target the Direct instance (ULTIPA_HOST${INSTANCE_HOST ? ` = ${INSTANCE_HOST}` : ""}). Pass any other instance ID to route via Ultipa Cloud.`
              : "Instance ID. Required — no Direct instance is configured, so there's no default target.",
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
    "test_connection",
    "Quick health check on the target GQLDB instance — call this when the user asks 'can you see/connect my instance' / 'is my GQLDB reachable'. Resolves the target (Mode A: fetches creds via Cloud; Mode B: uses env vars), opens or reuses a gRPC connection, logs in, and runs `healthCheck()`. Returns `{ ok, target, status, latencyMs, error? }`. Much faster than running a real query — use this as the first probe.",
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
    "run_gql_query",
    "Execute a literal GQL query against a GQLDB instance and return the result rows. Reuses an open gRPC connection per instance (lazy-init on first call, closed on server shutdown). For Mode A targets, fetches credentials via `get_instance_credentials` on first connect — that API key needs the `instances:credentials` scope. Call `lookup_docs` for the relevant topic first if uncertain about Ultipa-specific GQL syntax — training data is patchy on edges.",
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
    "run_algo",
    "Run a built-in graph algorithm. GQLDB ships dozens of algorithms across categories: **centrality** (PageRank, Betweenness, Closeness, ArticleRank, Katz, HITS, etc.), **community detection** (Louvain, Leiden, Label Propagation, K-Means, HANP, etc.), **similarity**, **pathfinding** (shortest paths, BFS/DFS, k-hop), **graph embeddings**, and more. Reach for this on analytical questions ('find influential users' → PageRank; 'detect communities' → Louvain; 'shortest route X to Y' → ShortestPath) instead of hand-computing them in raw GQL — the built-ins are dramatically faster on large graphs. **Discovery**: call `lookup_docs('graph-algorithms/pages/introduction')` for the full catalog by category, then `lookup_docs('graph-algorithms/pages/<category>/<algorithm>')` for one algorithm's exact signature and parameters (e.g. `centrality/pagerank`, `community-detection/louvain`, `pathfinding/mst`). Same execution path as `run_gql_query`; this is a focused affordance so the agent surfaces the algorithm catalog instead of missing it. For non-algo, use `run_gql_query` directly.",
    {
      ...idArg,
      gql: z
        .string()
        .min(1)
        .describe(
          "The full `CALL algo.<name>(...)` statement. Compose it from `lookup_docs` of the algorithm's reference page.",
        ),
      ...graphArg,
    },
    async (args: { id?: string; gql: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const cfg: QueryConfig = {};
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (graphName) cfg.graphName = graphName;
      const response = await client.gql(args.gql, cfg);
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "list_graphs",
    "List all graphs available on the target GQLDB instance (returns the SDK's `GraphInfo[]` — name, mode, node/edge counts, etc.).",
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

  server.tool(
    "create_graph",
    "Create a new graph on the GQLDB instance. Ask user which graph mode is wanted if you do not know. Three options: (1) **open**: schema-free graph; labels and properties spring into existence as data is inserted. (2) **closed**: schema-enforced graph; must supply one of: `inlineDefinition` (raw graph-type fragment that goes inside `{ ... }`), `likeGraph` (copy another graph's schema), or `typedName` (bind to a named graph type). `inlineDefinition` tips: node/edge type name is the key label, node type carries optional implied labels via `:Label` syntax (joined with `&` for multiples). Example, `'NODE User (:Employee {name STRING, age UINT32}), NODE Product ({name STRING}), EDGE PURCHASED (User)-[{ts DATETIME}]->(Product)'` creates `User` nodes with label set `:User&Employee`. Edge types do NOT support implied labels. Before composing a non-trivial `inlineDefinition`, call `lookup_docs('gql/pages/graph-management/closed-graphs')` for reference. (3) **ontology**: special mode for modeling RDF data with OWL semantics. After creation, the user loads prefixes and defines classes/properties separately, you can call `lookup_docs('ontology/pages/introduction')`, `lookup_docs('ontology/pages/class-definitions')`, `lookup_docs('ontology/pages/object-properties')` and `lookup_docs('ontology/pages/data-properties')` for reference if user needs further direction.",
    {
      ...idArg,
      name: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
        .describe(
          "Graph name. Must start with a letter or underscore, then letters / digits / underscores only.",
        ),
      mode: z
        .enum(["open", "closed", "ontology"])
        .default("open")
        .describe("'open' for schema-free; 'closed' for schema-enforced (requires one of typedName / likeGraph / inlineDefinition); 'ontology' for RDF / OWL-style semantic graphs."),
      typedName: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
        .optional()
        .describe("Closed mode only. Name of an existing named graph type to bind to. Mutually exclusive with likeGraph and inlineDefinition."),
      likeGraph: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
        .optional()
        .describe("Closed mode only. Name of an existing graph whose schema should be copied (no binding). Mutually exclusive with typedName and inlineDefinition."),
      inlineDefinition: z
        .string()
        .optional()
        .describe("Closed mode only. Raw GQL type-definition fragment to embed inside `{ ... }`. Mutually exclusive with typedName and likeGraph."),
    },
    async (args: {
      id?: string;
      name: string;
      mode: "open" | "closed" | "ontology";
      typedName?: string;
      likeGraph?: string;
      inlineDefinition?: string;
    }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);

      let gql: string;
      if (args.mode === "open") {
        if (args.typedName || args.likeGraph || args.inlineDefinition) {
          throw new Error(
            "Open graphs don't take typedName / likeGraph / inlineDefinition. Drop those args or change mode.",
          );
        }
        gql = `CREATE GRAPH ${args.name}`;
      } else if (args.mode === "ontology") {
        if (args.typedName || args.likeGraph || args.inlineDefinition) {
          throw new Error(
            "Ontology graphs don't take typedName / likeGraph / inlineDefinition. The user defines classes / properties / prefixes after create (see https://www.ultipa.com/docs/ontology).",
          );
        }
        gql = `CREATE GRAPH ${args.name} WITH ONTOLOGY`;
      } else {
        const provided = [
          args.typedName,
          args.likeGraph,
          args.inlineDefinition,
        ].filter((v) => v !== undefined && v !== "").length;
        if (provided !== 1) {
          throw new Error(
            "Closed graphs require exactly one of: typedName, likeGraph, or inlineDefinition.",
          );
        }
        if (args.typedName) {
          gql = `CREATE GRAPH ${args.name} TYPED ${args.typedName}`;
        } else if (args.likeGraph) {
          gql = `CREATE GRAPH ${args.name} LIKE ${args.likeGraph}`;
        } else {
          gql = `CREATE GRAPH ${args.name} { ${args.inlineDefinition} }`;
        }
      }

      const response = await client.gql(gql);
      return json({
        created: true,
        name: args.name,
        mode: args.mode,
        statement: gql,
        result: serializeResponse(response),
      });
    },
  );

  server.tool(
    "delete_graph",
    "Drop a graph from the GQLDB instance. **Destructive: permanently removes all nodes, edges, and indices belonging to the graph.** The instance and other graphs are not affected. Only call when the user has explicitly confirmed they want this graph gone — once dropped, the data is unrecoverable.",
    {
      ...idArg,
      name: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
        .describe(
          "Graph name to drop. Must start with a letter or underscore, then letters / digits / underscores only.",
        ),
    },
    async (args: { id?: string; name: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const gql = `DROP GRAPH ${args.name}`;
      const response = await client.gql(gql);
      return json({
        deleted: true,
        name: args.name,
        statement: gql,
        result: serializeResponse(response),
      });
    },
  );

  server.tool(
    "write_data",
    "If the GQL you are about to send contains `INSERT` statements built from rows in a file/CSV/JSON the user shared, you are using the WRONG tool — call `import_data` instead. This rule applies regardless of how natural composing INSERT statements feels; file-derived bulk writes MUST go through `import_data`. Continue here only if user wrote out a small literal record in-conversation.",
    {
      ...idArg,
      gql: z
        .string()
        .min(1)
        .describe(
          "The GQL write statement (INSERT / INSERT OVERWRITE / UPSERT / MERGE / FOREACH). Call `lookup_docs('gql/pages/data-manipulation/<statement>')` first if unsure of syntax (slugs: `insert`, `insert-overwrite`, `upsert`, `merge`, `foreach`). For node/edge `_id` semantics, call `lookup_docs('gql/pages/data-manipulation/node-and-edge-ids')`.",
        ),
      ...graphArg,
    },
    async (args: { id?: string; gql: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const cfg: QueryConfig = {};
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (graphName) cfg.graphName = graphName;
      const response = await client.gql(args.gql, cfg);
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "import_data",
    "**The right tool when the user attached / uploaded / pasted any file or row-shaped data.** Writes structured nodes and/or edges into a graph via the driver's gRPC bulk-insert path. **Do not hand-compose `INSERT` statements from file rows — use this instead.** **BEFORE calling, MUST stop and preview your plan to the user: node labels and edge labels, which column maps to `_id`, which columns map to `_from` / `_to` for edges (i.e. `fromNodeId` / `toNodeId`), which columns become which properties, the `mode` (normal / overwrite / upsert), and row counts. Wait for the user's 'go' or corrections. Bypasses GQL composition entirely: node and edge data go straight over gRPC, no statement to construct. **Format-agnostic at the wire**: parse the source on your side (CSV / JSON / JSONL / GraphML / pasted text / attached file) into the canonical `nodes` and `edges` arrays, then call this once. `mode` controls duplicate-`_id` semantics: `normal` (error on duplicate, default), `overwrite` (replace whole record), `upsert` (preserve existing properties, update supplied ones). Nodes are written BEFORE edges in a single call, so edges can reference newly-created nodes' `_id`s in the same batch.",
    {
      ...idArg,
      ...graphArg,
      nodes: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe(
                "Custom `_id`. Omit to let GQLDB assign a UUID v4. See `lookup_docs('gql/pages/data-manipulation/node-and-edge-ids')`.",
              ),
            labels: z
              .array(z.string())
              .describe(
                "Node labels. Open graphs accept any; closed graphs must match a defined node type's full label set (e.g. `['User', 'Employee']`).",
              ),
            properties: z
              .record(z.string(), z.any())
              .describe(
                "Property name → value. Closed graphs validate against the node type's defined properties; open graphs accept any.",
              ),
          }),
        )
        .optional()
        .describe(
          "Nodes to insert. At least one of `nodes` / `edges` must be non-empty.",
        ),
      edges: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe(
                "Custom `_id`. Requires `EDGE_ID ENABLED` on the graph; omit otherwise.",
              ),
            label: z
              .string()
              .describe(
                "Edge label (single label per edge — GQL edges don't support multi-label).",
              ),
            fromNodeId: z.string().describe("Source node's `_id`."),
            toNodeId: z.string().describe("Destination node's `_id`."),
            properties: z
              .record(z.string(), z.any())
              .describe("Property name → value."),
          }),
        )
        .optional()
        .describe(
          "Edges to insert. Written AFTER nodes in the same call, so edges may reference nodes inserted in this batch.",
        ),
      mode: z
        .enum(["normal", "overwrite", "upsert"])
        .default("normal")
        .describe(
          "Duplicate-`_id` semantics. `normal` errors on duplicate. `overwrite` replaces the whole record (unlisted properties dropped). `upsert` merges (existing properties preserved, supplied properties updated, labels unioned for nodes).",
        ),
      skipInvalidEdges: z
        .boolean()
        .default(true)
        .describe(
          "Edges only. When true, edges whose endpoint `_id` doesn't exist in the graph are skipped (counted in the result's `skippedCount`); when false, an invalid endpoint errors the whole edge batch.",
        ),
    },
    async (args: {
      id?: string;
      graph?: string;
      nodes?: NodeData[];
      edges?: EdgeData[];
      mode: "normal" | "overwrite" | "upsert";
      skipInvalidEdges: boolean;
    }) => {
      if (!args.nodes?.length && !args.edges?.length) {
        throw new Error(
          "import_data needs at least one of `nodes` / `edges` (non-empty array).",
        );
      }
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (!graphName) {
        throw new Error(
          "import_data needs a graph name. Pass the `graph` arg or set ULTIPA_GRAPH.",
        );
      }
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const insertType =
        args.mode === "overwrite"
          ? InsertType.Overwrite
          : args.mode === "upsert"
            ? InsertType.Upsert
            : InsertType.Normal;
      // Use the bulk-gRPC overload (string graphName first). Auto variants
      // chunk large arrays internally so a single call survives big imports.
      const out: Record<string, any> = { graph: graphName, mode: args.mode };
      if (args.nodes?.length) {
        out.nodes = await client.insertNodesBatchAuto(graphName, args.nodes, {
          options: { mode: insertType },
        });
      }
      if (args.edges?.length) {
        out.edges = await client.insertEdgesBatchAuto(graphName, args.edges, {
          options: {
            mode: insertType,
            skipInvalidNodes: args.skipInvalidEdges,
          },
        });
      }
      return json(out);
    },
  );

  server.tool(
    "write_procedure",
    "Create a stored procedure in GQLDB. **CRITICAL**: the procedure body is **NOT GQL** — it has its own grammar (control flow, expressions, iterators, traversal, parallel execution, built-in functions). Do NOT compose the body from GQL knowledge alone — the model's training data does not cover Ultipa's procedure body language. **Always `lookup_docs` BEFORE composing**: start with `lookup_docs('stored-procedures/pages/procedure-body/procedure-body-language')` for the overall grammar, then per-topic pages as needed: `procedure-body/control-flow` (if/while/for), `procedure-body/expressions`, `procedure-body/iterators-and-traversal`, `procedure-body/data-operations`, `procedure-body/parallel-execution`, `procedure-body/builtin-functions`. For the outer `CREATE PROCEDURE` envelope and parameter syntax, see `lookup_docs('stored-procedures/pages/procedure-management')`. To CALL the procedure later, use `run_gql_query` with `CALL <name>(...)`. To MANAGE (drop / show / alter) procedures, use `run_gql_query` directly.",
    {
      ...idArg,
      gql: z
        .string()
        .min(1)
        .describe(
          "The full `CREATE PROCEDURE <name>(<params>) ...` statement including the body. Compose from `lookup_docs` of the procedure body language reference.",
        ),
      ...graphArg,
    },
    async (args: { id?: string; gql: string; graph?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const cfg: QueryConfig = {};
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (graphName) cfg.graphName = graphName;
      const response = await client.gql(args.gql, cfg);
      return json(serializeResponse(response));
    },
  );

  server.tool(
    "get_db_version",
    "Return the live GQLDB version reported by the instance itself. Use this when you want ground truth — the Cloud control plane's `get_instance.version` field is what Ultipa Cloud *believes* the instance runs (from metadata), which can briefly diverge during/after an upgrade. Mode B users can only get the version this way.",
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
    "Return the instance's edition and license info. Useful for confirming the running edition (Community / Enterprise / etc.), license expiry, and any feature flags tied to the license.",
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
    "Rebuild the instance's stored statistics. Use when the stats look stale or wrong (e.g. after a bulk import, or if `describe_schema`'s `stats` field looks off). Side effect: can be heavy on large datasets — avoid calling mid-traffic on a busy production instance unless you have to.",
    { ...idArg },
    async (args: { id?: string }) => {
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const response = await client.gql("RETURN db.reload_stats()");
      return json(serializeResponse(response));
    },
  );
}

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
import { readFile } from "node:fs/promises";

// Minimal RFC 4180-style CSV parser used by `import_data`'s CSV pass-through.
// Handles quoted fields with commas/newlines inside, escaped quotes (`""` → `"`),
// CRLF / LF line endings, UTF-8 BOM, and a missing trailing newline. Default
// delimiter is `,`. For non-standard CSVs (custom delimiter, leading metadata
// rows, exotic quoting), the agent should preprocess client-side and use the
// canonical `nodes`/`edges` arrays instead.
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore; `\n` handles row break
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Coerce a raw CSV cell (always a string) into the requested type. Empty cells
// become null. Unknown / passthrough types return the original string so the
// server can do its own coercion if applicable.
function coerceCell(value: string, type?: string): any {
  if (value === "") return null;
  if (!type) return value;
  switch (type.toUpperCase()) {
    case "INT":
    case "INTEGER":
    case "BIGINT": {
      const n = parseInt(value, 10);
      if (Number.isNaN(n))
        throw new Error(`Cannot coerce "${value}" to INT`);
      return n;
    }
    case "FLOAT":
    case "DOUBLE": {
      const f = parseFloat(value);
      if (Number.isNaN(f))
        throw new Error(`Cannot coerce "${value}" to FLOAT`);
      return f;
    }
    case "BOOL":
    case "BOOLEAN": {
      const v = value.trim().toLowerCase();
      if (["true", "t", "yes", "y", "1"].includes(v)) return true;
      if (["false", "f", "no", "n", "0"].includes(v)) return false;
      throw new Error(`Cannot coerce "${value}" to BOOL`);
    }
    default:
      // STRING, TIMESTAMP, DATE, ZONED_DATETIME, etc. — pass through.
      return value;
  }
}

// Convert parsed CSV content + companion fields into canonical NodeData[] /
// EdgeData[]. Shared by inline `csv` content mode and `filePath` (CSV files).
function csvToCanonical(
  content: string,
  opts: {
    label: string;
    idColumn?: string;
    fromColumn?: string;
    toColumn?: string;
    properties?: Array<{ property: string; column: string; type?: string }>;
  },
): { nodes?: NodeData[]; edges?: EdgeData[]; rowCount: number } {
  if (!!opts.fromColumn !== !!opts.toColumn) {
    throw new Error(
      "CSV edge mode requires BOTH `csvFromColumn` and `csvToColumn`.",
    );
  }
  const isEdgeMode = !!opts.fromColumn;
  const rows = parseCsv(content);
  if (rows.length < 1) throw new Error("CSV is empty (no header row).");
  const header = rows[0];
  const dataRows = rows
    .slice(1)
    .filter((r) => !(r.length === 1 && r[0] === ""));
  const colIdx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0)
      throw new Error(
        `CSV column "${name}" not found in header: ${header.join(", ")}`,
      );
    return i;
  };
  const idIdx = opts.idColumn ? colIdx(opts.idColumn) : -1;
  const fromIdx = isEdgeMode ? colIdx(opts.fromColumn!) : -1;
  const toIdx = isEdgeMode ? colIdx(opts.toColumn!) : -1;
  const excluded = new Set([idIdx, fromIdx, toIdx].filter((i) => i >= 0));
  const propMapping: Array<{
    property: string;
    colIdx: number;
    type?: string;
  }> = opts.properties
    ? opts.properties.map((m) => ({
        property: m.property,
        colIdx: colIdx(m.column),
        type: m.type,
      }))
    : header
        .map((col, i) =>
          excluded.has(i) ? null : { property: col, colIdx: i },
        )
        .filter((m): m is { property: string; colIdx: number } => m !== null);
  const buildProps = (row: string[]): Record<string, any> => {
    const props: Record<string, any> = {};
    for (const m of propMapping) {
      props[m.property] = coerceCell(row[m.colIdx] ?? "", m.type);
    }
    return props;
  };
  if (isEdgeMode) {
    const edges: EdgeData[] = dataRows.map((row, i) => {
      const fromNodeId = row[fromIdx];
      const toNodeId = row[toIdx];
      if (!fromNodeId || !toNodeId)
        throw new Error(`Row ${i + 2}: missing _from / _to (both required).`);
      const edge: EdgeData = {
        label: opts.label,
        fromNodeId,
        toNodeId,
        properties: buildProps(row),
      };
      if (idIdx >= 0 && row[idIdx]) edge.id = row[idIdx];
      return edge;
    });
    return { edges, rowCount: edges.length };
  }
  const nodes: NodeData[] = dataRows.map((row) => {
    const node: NodeData = {
      labels: [opts.label],
      properties: buildProps(row),
    };
    if (idIdx >= 0 && row[idIdx]) node.id = row[idIdx];
    return node;
  });
  return { nodes, rowCount: nodes.length };
}

// Convert JSON / JSONL content into canonical NodeData[] / EdgeData[].
// Auto-detects shape: `NodeData[]` (labels array on first item), `EdgeData[]`
// (fromNodeId/toNodeId on first item), or `{nodes, edges}` mixed object.
function jsonToCanonical(
  content: string,
  isJsonl: boolean,
): { nodes?: NodeData[]; edges?: EdgeData[] } {
  let parsed: any;
  if (isJsonl) {
    parsed = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (e: any) {
          throw new Error(
            `Invalid JSON on line ${i + 1}: ${e?.message ?? String(e)}`,
          );
        }
      });
  } else {
    try {
      parsed = JSON.parse(content);
    } catch (e: any) {
      throw new Error(`Invalid JSON: ${e?.message ?? String(e)}`);
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error("JSON array is empty.");
    const first = parsed[0];
    if (
      first &&
      typeof first === "object" &&
      "fromNodeId" in first &&
      "toNodeId" in first
    ) {
      return { edges: parsed as EdgeData[] };
    }
    if (first && typeof first === "object" && Array.isArray(first.labels)) {
      return { nodes: parsed as NodeData[] };
    }
    throw new Error(
      `Cannot detect JSON shape. Array items must be NodeData ({labels, properties, id?}) or EdgeData ({label, fromNodeId, toNodeId, properties, id?}). First item: ${JSON.stringify(first).slice(0, 200)}`,
    );
  }
  if (parsed && typeof parsed === "object" && (parsed.nodes || parsed.edges)) {
    return {
      nodes: parsed.nodes as NodeData[] | undefined,
      edges: parsed.edges as EdgeData[] | undefined,
    };
  }
  throw new Error(
    "JSON root must be NodeData[] / EdgeData[] / {nodes, edges}.",
  );
}

// Dispatch a host file path to the right parser by extension. CSV requires
// `csvLabel` + companion fields; JSON / JSONL parse straight into canonical
// shape with no extra config.
async function loadFilePath(
  path: string,
  csvOpts: {
    label?: string;
    idColumn?: string;
    fromColumn?: string;
    toColumn?: string;
    properties?: Array<{ property: string; column: string; type?: string }>;
  },
): Promise<{
  nodes?: NodeData[];
  edges?: EdgeData[];
  format: "csv" | "json" | "jsonl";
  rowCount?: number;
}> {
  const ext = path.toLowerCase().split(".").pop();
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (e: any) {
    throw new Error(
      `Cannot read file "${path}": ${e?.message ?? String(e)}. Path must be readable by the MCP process (typically the user's local machine for stdio MCPs).`,
    );
  }
  if (ext === "csv") {
    if (!csvOpts.label) {
      throw new Error(
        "CSV `filePath` requires `csvLabel` (the node or edge label).",
      );
    }
    const { nodes, edges, rowCount } = csvToCanonical(content, {
      label: csvOpts.label,
      idColumn: csvOpts.idColumn,
      fromColumn: csvOpts.fromColumn,
      toColumn: csvOpts.toColumn,
      properties: csvOpts.properties,
    });
    return { nodes, edges, format: "csv", rowCount };
  }
  if (ext === "json" || ext === "jsonl") {
    const { nodes, edges } = jsonToCanonical(content, ext === "jsonl");
    return { nodes, edges, format: ext as "json" | "jsonl" };
  }
  throw new Error(
    `Unsupported file extension ".${ext}" for "${path}". Supported: .csv, .json, .jsonl`,
  );
}

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
    "Use this when user uploaded/pasted any file or row-shaped data. Bulk-writes structured nodes/edges to a graph. Do NOT compose `INSERT` statements from file rows. Three import methods: (1) `filePath`. If user hasn't point you a filepath but only uploaded files to chat, STOP and HIGHLY RECOMMEND (actively, proactively) user to tell you where the files are stored so you can get `filePath`, and emphasize 'fast', 'save tokens' and 'no bacthing'. DO NOT fallback to other two methods. NOTE: once files uploaded to chat, you get paths in your agent sandbox, that path will FAIL. Keep asking user where the files are saved (most often on user's local machine). (2) `csv` (raw CSV string; subject to output cap, needs batching). (3) `nodes`/`edges` (canonical arrays; subject to output cap, needs batching). **For >2000 rows, push HARDER**: methods 2/3 are painfully slow, prone to truncation, and burn tokens. Only proceed with methods 2/3 if the user explicitly insists. **Before calling**: preview the plan (method, labels, `_id` / `_from` / `_to` columns, property mapping, `mode`, row counts) and wait for explicit user approval. **Batching**: per-response output cap ~8k tokens; if rows > ~500 (CSV) / ~150 (arrays), split into multiple calls. `filePath` has no such limit. **Retry safety**: before retrying after a failed/truncated import, run `run_gql_query` (`MATCH (n:<Label>) RETURN count(n)` etc.) to see what's already imported and resend only missing rows. `mode`: `normal` (error on duplicate `_id`, default), `overwrite` (replace), `upsert` (merge). Nodes written BEFORE edges so edges can reference fresh node `_id`s.",
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
      filePath: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Path to `.csv` / `.json` / `.jsonl` on the **MCP host's filesystem** (typically the user's machine for stdio MCPs) — NOT your agent sandbox. Sandbox paths like `/mnt/user-data/uploads/...` will fail with ENOENT. Use only paths the user explicitly gave you. Format detected by extension. CSV requires `csvLabel` + companion fields. JSON/JSONL must be canonical shape (`NodeData[]` / `EdgeData[]` / `{nodes, edges}`).",
        ),
      csv: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Raw CSV with header row. Requires `csvLabel` (+ `csvFromColumn` / `csvToColumn` for edges). Default `,` delimiter, `\"` quote. For exotic CSV, preprocess and use `nodes` / `edges`.",
        ),
      csvLabel: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional()
        .describe(
          "Node label (when `csvFromColumn`/`csvToColumn` unset) or edge label (when both set). Single label only — for multi-label nodes use the `nodes` array form.",
        ),
      csvIdColumn: z
        .string()
        .min(1)
        .optional()
        .describe(
          "CSV column to use as `_id`. Omit to let GQLDB assign UUIDs.",
        ),
      csvFromColumn: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Edge source `_id` column. Triggers edge mode (pair with `csvToColumn`).",
        ),
      csvToColumn: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Edge destination `_id` column. Triggers edge mode (pair with `csvFromColumn`).",
        ),
      csvProperties: z
        .array(
          z.object({
            property: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .describe("Property name to write."),
            column: z
              .string()
              .min(1)
              .describe("CSV header column to read from."),
            type: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
              .optional()
              .describe(
                "Optional type coercion (`INT`, `FLOAT`, `BOOL`). Other types (`STRING`, `TIMESTAMP`, `DATE`, …) pass through as strings.",
              ),
          }),
        )
        .optional()
        .describe(
          "Per-property mapping. Omit to default every non-`_id` / `_from` / `_to` column to a same-named STRING property.",
        ),
      mode: z
        .enum(["normal", "overwrite", "upsert"])
        .default("normal")
        .describe(
          "Duplicate-`_id` semantics. `normal` errors. `overwrite` replaces the whole record. `upsert` merges (preserves existing properties, updates supplied; unions labels for nodes).",
        ),
      skipInvalidEdges: z
        .boolean()
        .default(true)
        .describe(
          "Edges only. Skip edges whose endpoint `_id` is missing in the graph (counted in `skippedCount`). When `false`, an invalid endpoint errors the batch.",
        ),
    },
    async (args: {
      id?: string;
      graph?: string;
      nodes?: NodeData[];
      edges?: EdgeData[];
      csv?: string;
      filePath?: string;
      csvLabel?: string;
      csvIdColumn?: string;
      csvFromColumn?: string;
      csvToColumn?: string;
      csvProperties?: Array<{ property: string; column: string; type?: string }>;
      mode: "normal" | "overwrite" | "upsert";
      skipInvalidEdges: boolean;
    }) => {
      // ── 1. Validate import method ─────────────────────────────────────
      const usingArrays = !!(args.nodes?.length || args.edges?.length);
      const usingCsv = !!args.csv;
      const usingFilePath = !!args.filePath;
      const modesSet = [usingArrays, usingCsv, usingFilePath].filter(
        Boolean,
      ).length;
      if (modesSet === 0) {
        throw new Error(
          "import_data needs one of: `nodes`/`edges` (canonical arrays), `csv` (raw CSV content), or `filePath` (host path to a .csv, .json, or .jsonl file).",
        );
      }
      if (modesSet > 1) {
        throw new Error(
          "import_data: `nodes`/`edges`, `csv`, and `filePath` are mutually exclusive — pick one import method per call.",
        );
      }
      const graphName = args.graph ?? DEFAULT_GRAPH;
      if (!graphName) {
        throw new Error(
          "import_data needs a graph name. Pass the `graph` arg or set ULTIPA_GRAPH.",
        );
      }

      // ── 2. Compute final nodes / edges arrays ─────────────────────────
      let nodes: NodeData[] | undefined;
      let edges: EdgeData[] | undefined;
      let parsedFrom:
        | { source: string; format?: string; rows?: number; label?: string }
        | undefined;

      if (usingArrays) {
        nodes = args.nodes;
        edges = args.edges;
      } else if (usingFilePath) {
        const loaded = await loadFilePath(args.filePath!, {
          label: args.csvLabel,
          idColumn: args.csvIdColumn,
          fromColumn: args.csvFromColumn,
          toColumn: args.csvToColumn,
          properties: args.csvProperties,
        });
        nodes = loaded.nodes;
        edges = loaded.edges;
        parsedFrom = {
          source: `filePath=${args.filePath}`,
          format: loaded.format,
          rows: loaded.rowCount,
          label: args.csvLabel,
        };
      } else {
        // Inline CSV content
        if (!args.csvLabel) {
          throw new Error(
            "import_data CSV mode requires `csvLabel` (the node or edge label).",
          );
        }
        const { nodes: csvNodes, edges: csvEdges, rowCount } = csvToCanonical(
          args.csv!,
          {
            label: args.csvLabel,
            idColumn: args.csvIdColumn,
            fromColumn: args.csvFromColumn,
            toColumn: args.csvToColumn,
            properties: args.csvProperties,
          },
        );
        nodes = csvNodes;
        edges = csvEdges;
        parsedFrom = {
          source: "csv (inline content)",
          format: "csv",
          rows: rowCount,
          label: args.csvLabel,
        };
      }

      // ── 3. Open a bulk-import session ─────────────────────────────────
      // The driver's insertNodes/insertEdges (bulk gRPC path) require an
      // active bulk-import session on the server side. Without
      // `bulkImportSessionId`, the request fails with "insert without an
      // active bulk-import session". The session is per-import: open before
      // any insert, end after all inserts succeed, abort on failure.
      const target = resolveDataPlaneTarget(args.id);
      const client = await getDataPlaneClient(target);
      const insertType =
        args.mode === "overwrite"
          ? InsertType.Overwrite
          : args.mode === "upsert"
            ? InsertType.Upsert
            : InsertType.Normal;
      const session = await client.startBulkImport(graphName, {
        estimatedNodes: nodes?.length,
        estimatedEdges: edges?.length,
      });
      if (!session.success) {
        throw new Error(
          `Failed to start bulk-import session on graph "${graphName}": ${session.message}`,
        );
      }

      // ── 4. Insert under the session, then end (or abort on error) ────
      const out: Record<string, any> = {
        graph: graphName,
        mode: args.mode,
        sessionId: session.sessionId,
      };
      if (parsedFrom) out.parsedFrom = parsedFrom;
      try {
        if (nodes?.length) {
          out.nodes = await client.insertNodesBatchAuto(graphName, nodes, {
            options: { mode: insertType },
            bulkImportSessionId: session.sessionId,
          });
        }
        if (edges?.length) {
          out.edges = await client.insertEdgesBatchAuto(graphName, edges, {
            options: {
              mode: insertType,
              skipInvalidNodes: args.skipInvalidEdges,
            },
            bulkImportSessionId: session.sessionId,
          });
        }
        const ended = await client.endBulkImport(session.sessionId);
        out.endResult = {
          totalRecords: ended.totalRecords,
          message: ended.message,
        };
      } catch (e: any) {
        await client.abortBulkImport(session.sessionId).catch(() => {});
        throw new Error(
          `Bulk-import session ${session.sessionId} aborted: ${e?.message ?? String(e)}`,
        );
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

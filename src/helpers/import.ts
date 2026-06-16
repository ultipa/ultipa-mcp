// Import helpers used by `import_data` in src/tools/dataplane.ts.
// Kept separate so they're easy to unit-test and so dataplane.ts stays focused
// on tool registrations.

import { readFile } from "node:fs/promises";
import type { EdgeData, NodeData } from "@ultipa-graph/ultipa-driver";

// Minimal RFC 4180-style CSV parser used by `import_data`'s CSV pass-through.
// Handles quoted fields with delimiter/newlines inside, escaped quotes
// (`""` → `"`), CRLF / LF line endings, UTF-8 BOM, and a missing trailing
// newline. Defaults: delimiter = `,`, quote = `"`. Both single-character
// overrides supported for TSV / semicolon CSV / Windows CSVs etc. For more
// exotic formats (multi-char delimiter, leading metadata rows), the agent
// should preprocess client-side and use canonical `nodes`/`edges` arrays.
export function parseCsv(
  text: string,
  opts: { delimiter?: string; quote?: string } = {},
): string[][] {
  const delimiter = opts.delimiter ?? ",";
  const quote = opts.quote ?? '"';
  if (delimiter.length !== 1) {
    throw new Error(
      `CSV delimiter must be a single character; got "${delimiter}".`,
    );
  }
  if (quote.length !== 1) {
    throw new Error(`CSV quote must be a single character; got "${quote}".`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === quote) {
      inQuotes = true;
    } else if (c === delimiter) {
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
export function coerceCell(value: string, type?: string): any {
  if (value === "") return null;
  if (!type) return value;
  switch (type.toUpperCase()) {
    case "INT":
    case "INTEGER":
    case "BIGINT": {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) throw new Error(`Cannot coerce "${value}" to INT`);
      return n;
    }
    case "FLOAT":
    case "DOUBLE": {
      const f = parseFloat(value);
      if (Number.isNaN(f)) throw new Error(`Cannot coerce "${value}" to FLOAT`);
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
export function csvToCanonical(
  content: string,
  opts: {
    label: string;
    idColumn?: string;
    fromColumn?: string;
    toColumn?: string;
    properties?: Array<{ property: string; column: string; type?: string }>;
    delimiter?: string;
    quote?: string;
  },
): { nodes?: NodeData[]; edges?: EdgeData[]; rowCount: number } {
  if (!!opts.fromColumn !== !!opts.toColumn) {
    throw new Error(
      "CSV edge mode requires BOTH `csvFromColumn` and `csvToColumn`.",
    );
  }
  const isEdgeMode = !!opts.fromColumn;
  const rows = parseCsv(content, {
    delimiter: opts.delimiter,
    quote: opts.quote,
  });
  const header = rows[0];
  if (!header) throw new Error("CSV is empty (no header row).");
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
export function jsonToCanonical(
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
export async function loadFilePath(
  path: string,
  csvOpts: {
    label?: string;
    idColumn?: string;
    fromColumn?: string;
    toColumn?: string;
    properties?: Array<{ property: string; column: string; type?: string }>;
    delimiter?: string;
    quote?: string;
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
      delimiter: csvOpts.delimiter,
      quote: csvOpts.quote,
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Topic slugs are full repo paths without the `.md` extension.
// What's in this array is what's in the ultipa-docs repo, verbatim — no hidden
// transformations. To add a new topic, copy the path from the repo and drop `.md`.
const TOPICS = [
  // gql / graph pattern matching
  "gql/graph-pattern-matching/graph-pattern-matching",
  "gql/graph-pattern-matching/node-and-edge-patterns",
  "gql/graph-pattern-matching/graph-patterns",
  "gql/graph-pattern-matching/path-patterns",
  "gql/graph-pattern-matching/quantified-paths",
  "gql/graph-pattern-matching/questioned-paths",
  "gql/graph-pattern-matching/shortest-paths",
  "gql/graph-pattern-matching/cheapest-paths",
  "gql/graph-pattern-matching/khop-traversal",
  // gql / graph management
  "gql/graph-management/graphs",
  "gql/graph-management/closed-graphs",
  // gql / data manipulation
  "gql/data-manipulation/node-and-edge-ids",
  "gql/data-manipulation/insert",
  "gql/data-manipulation/insert-overwrite",
  "gql/data-manipulation/upsert",
  "gql/data-manipulation/merge",
  "gql/data-manipulation/foreach",
  // gql / querying
  "gql/querying/query-composition",
  // gql / functions, operators, predicates, expressions
  "gql/functions/all-functions",
  "gql/operators",
  "gql/predicates",
  "gql/expressions",
  // query perfermance
  "gql/query-acceleration/index",
  "gql/query-acceleration/fulltext-index",
  "computing-engine/introduction",
  // ontology (RDF / OWL semantics for ontology-mode graphs)
  "ontology/introduction",
  "ontology/class-definitions",
  "ontology/object-properties",
  "ontology/data-properties",
  // graph-algorithms
  "graph-algorithms/introduction",
  "graph-algorithms/running-algorithms",
  // stored-produceres
  "stored-procedures/quick-start",
  "stored-procedures/procedure-management",
  "stored-procedures/calling-procedures",
  "stored-procedures/procedure-body/procedure-body-language",
] as const;

const REPO_BASE = "https://raw.githubusercontent.com/ultipa/ultipa-docs/main";
const TREE_API_URL =
  "https://api.github.com/repos/ultipa/ultipa-docs/git/trees/main?recursive=1";

// Reserved `topic` value that triggers a live fetch of the full doc page index
// (from GitHub's tree API) instead of fetching a single markdown page.
const INDEX_SLUG = "?";

// Cache the index for the process lifetime — the tree rarely changes within a
// session and unauth GitHub API has a 60 req/hour limit. On failure, clear so
// the next call retries instead of returning a poisoned rejected promise.
let cachedIndex: Promise<string[]> | null = null;

async function fetchRepoIndex(): Promise<string[]> {
  if (cachedIndex) return cachedIndex;
  const promise = (async () => {
    const res = await fetch(TREE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(
        `GitHub tree API returned ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      tree?: Array<{ path?: string; type?: string }>;
    };
    return (json.tree ?? [])
      .filter(
        (n) =>
          n.type === "blob" &&
          typeof n.path === "string" &&
          n.path.endsWith(".md") &&
          n.path.includes("/"),
      )
      .map((n) => (n.path as string).replace(/\.md$/, ""));
  })();
  cachedIndex = promise;
  promise.catch(() => {
    cachedIndex = null;
  });
  return promise;
}

// Convert a topic slug to its raw GitHub markdown URL — just append `.md`.
function topicToFetchUrl(topic: string): string {
  return `${REPO_BASE}/${topic}.md`;
}

// Convert a topic slug to its rendered docs URL (for human fallback links).
// `gql/graph-management/closed-graphs` → `https://www.ultipa.com/docs/gql/closed-graphs`
// (ultipa.com flattens intermediate segments; only first segment + final page slug matter.)
function topicToBrowseUrl(topic: string): string {
  const parts = topic.split("/");
  const section = parts[0];
  const page = parts[parts.length - 1];
  return `https://www.ultipa.com/docs/${section}/${page}`;
}

function catalogResponse(prefix: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${prefix}\n\n${TOPICS.map((t) => `- ${t}`).join("\n")}`,
      },
    ],
  };
}

// `lookup_docs` modes — single tool, three discovery layers, pay-as-you-go:
//
//   Call                                 Behavior
//   -----------------------------------  ----------------------------------------------------------
//   lookup_docs()                        Returns the curated TOPICS cheat-sheet. No network.
//   lookup_docs({ topic: "?" })          Hits GitHub tree API, returns all .md paths in the
//                                        repo (root README excluded). Cached for process
//                                        lifetime; on failure the cache clears so the next
//                                        call retries.
//   lookup_docs({ topic: "some/path" })  Fetches that page's raw markdown from the repo.
//   lookup_docs({ topic: "wrong/path" }) 404 from GitHub → handler returns error JSON with
//                                        fetchedUrl, fallbackUrl, and curatedEntryPoints so the
//                                        agent can self-correct in one round trip.
//
// No allowlist gate: any path is fetchable, validation is delegated to GitHub.
export function registerDocsTools(server: McpServer) {
  server.tool(
    "lookup_docs",
    `Look up an Ultipa documentation page by topic slug. Fetches the page's markdown content live from the public ultipa-docs repo on GitHub. Use this when you need authoritative reference on Ultipa-specific syntax, schema rules, functions, or features the model may not know fully from training data. Topic slugs are repo paths under https://github.com/ultipa/ultipa-docs without the \`.md\` extension; ANY valid path is fetchable, the list below is just curated entry points. Call WITHOUT a topic to see the cheat-sheet, or with \`topic: "?"\` to fetch the full live index of every doc page. Curated entry points: ${TOPICS.join(", ")}.`,
    {
      topic: z
        .string()
        .optional()
        .describe(
          `Any repo path under ultipa-docs without \`.md\` (e.g. \`${TOPICS[0]}\`). Pass \`?\` to fetch the full live index of every doc page from the repo. Omit to see the curated cheat-sheet of common entry points.`,
        ),
    },
    async ({ topic }) => {
      if (!topic) {
        return catalogResponse(
          'No topic provided. Curated entry points below (you can also pass any other valid repo path, or `topic: "?"` to fetch the full live index from the repo):',
        );
      }
      if (topic === INDEX_SLUG) {
        try {
          const all = await fetchRepoIndex();
          return {
            content: [
              {
                type: "text" as const,
                text: `Full index of ${all.length} doc pages in ultipa-docs (pass any of these as \`topic\` to fetch its markdown):\n\n${all.map((p) => `- ${p}`).join("\n")}`,
              },
            ],
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      "Failed to fetch repo index from GitHub. Fall back to the curated entry points below or pass a guessed slug directly.",
                    detail: e?.message ?? String(e),
                    curatedEntryPoints: TOPICS,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
      const fetchedUrl = topicToFetchUrl(topic);
      const fallbackUrl = topicToBrowseUrl(topic);
      try {
        const res = await fetch(fetchedUrl);
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Failed to fetch '${topic}' (${res.status} ${res.statusText}). Slug is likely wrong. **Next step**: call \`lookup_docs({ topic: "?" })\` to get the full live index of every doc page in the repo, locate the actual path for what you wanted, then re-call \`lookup_docs\` with the correct slug. Do NOT guess another slug blindly — the index is the authoritative list. As a fallback, the curated entry points below may also be close to what you need.`,
                    fetchedUrl,
                    fallbackUrl,
                    nextStep:
                      'Call lookup_docs({ topic: "?" }) to fetch the full index.',
                    curatedEntryPoints: TOPICS,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: await res.text() }] };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: `Network error fetching '${topic}'.`,
                  detail: e?.message ?? String(e),
                  fetchedUrl,
                  fallbackUrl,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

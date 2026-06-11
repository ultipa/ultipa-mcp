import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";
import { waitForSettled } from "../helpers/wait.js";
import { makeProgressReporter } from "../helpers/progress.js";

export function registerInstanceTools(server: McpServer) {
  // ── Read / discovery ────────────────────────────────────────────────────

  server.tool(
    "list_instances",
    "List all GQLDB instances on your Ultipa Cloud account.",
    {},
    async () => json(await api("/v1/instances")),
  );

  server.tool(
    "list_deleted_instances",
    "List instances that have been deleted from the account (kept as soft-deleted tombstones for audit / recovery). These do NOT appear in `list_instances`.",
    {},
    async () => json(await api("/v1/instances/deleted")),
  );

  server.tool(
    "get_instance",
    "Get details for a single instance by ID. Does NOT include the admin password — use get_instance_credentials for that.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}`)),
  );

  server.tool(
    "get_instance_credentials",
    "Fetch the admin DB credentials (adminUser + adminPassword) for an instance. Requires the API key to have the `instances:credentials` scope). The call is audit-logged server-side.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}/credentials`)),
  );

  server.tool(
    "list_regions",
    "List all regions Ultipa Cloud supports. Each entry has `value` (the region code used by `create_instance`, e.g. `us-east-1`), `label` (human-readable name), `provider` (e.g. `aws`), and `managerUrl` (the region's GQLDB Manager URL). Useful as a pre-step for `create_instance` or to give the user the right Manager URL for an instance.",
    {},
    async () => json(await api("/v1/regions")),
  );

  server.tool(
    "list_instance_sizes",
    "List available GQLDB instance sizes (CPU, memory, storage, pricing). Optionally filter by tier or region.",
    {
      tier: z
        .enum(["free_trial", "standard", "enterprise"])
        .optional()
        .describe("Filter by tier"),
      region: z
        .string()
        .optional()
        .describe("Filter by region code, e.g. us-east-1"),
    },
    async ({ tier, region }) => {
      const q = new URLSearchParams();
      if (tier) q.set("tier", tier);
      if (region) q.set("region", region);
      const qs = q.toString();
      return json(await api(`/v1/instance-sizes${qs ? `?${qs}` : ""}`));
    },
  );

  server.tool(
    "get_enterprise_status",
    "Check the account's enterprise-tier eligibility. Returns `{ hasActiveEnterprise, canCreateEnterprise }`. Only meaningful for accounts whose email has enterprise sizes assigned. Pre-check before `create_instance` with an `enterprise` size.",
    {},
    async () => json(await api("/v1/instances/enterprise-status")),
  );

  server.tool(
    "get_operations_lock",
    "Check whether instance operations are currently locked (Ultipa Cloud maintenance). Returns `{ locked }`. When `locked: true`, all write/destructive ops (create, pause, resume, restart, delete, etc.) will be rejected upstream. Useful as a pre-check before chaining state-change tools — if locked, tell the user to wait rather than triggering ops that will fail.",
    {},
    async () => json(await api("/v1/instances/operations-lock")),
  );

  server.tool(
    "get_trial_status",
    "Check the account's free-trial eligibility. Returns `{ trialStartsAt, trialEndsAt, hasActiveTrial, canCreateTrial }`. Call before `create_instance` with a `free_trial` size — if `canCreateTrial` is false (trial expired or one already running), creating will fail.",
    {},
    async () => json(await api("/v1/instances/trial-status")),
  );

  server.tool(
    "get_latest_version",
    "Return the latest available GQLDB version. Pair with `get_instance` to compare against an instance's current `version` before calling `upgrade_version` — saves a 409 'already on latest' from the server when there's nothing to upgrade.",
    {},
    async () => json(await api("/v1/gqldb-versions/latest")),
  );

  // ── State changes ───────────────────────────────────────────────────────

  server.tool(
    "create_instance",
    "Provision a new GQLDB instance. Blocks until the instance is fully provisioned and running (typically 30–60s). Returns the final instance object with `adminUser` and `adminPassword` merged in. **The `POST /v1/instances` response is the ONE place the password is surfaced** — subsequent GETs strip it — so surface the password to the user immediately on return. No follow-up `get_instance_credentials` call is needed.",
    {
      name: z.string().min(1).max(30).describe("Instance name (1–30 chars)"),
      region: z
        .string()
        .describe(
          "Region code, e.g. us-east-1. Use list_instance_sizes to see valid regions.",
        ),
      sizeId: z.string().describe("Size ID from list_instance_sizes"),
    },
    async ({ name, region, sizeId }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await onProgress?.("Submitting create request...", undefined);
      // POST /v1/instances is the only place adminPassword is surfaced — capture
      // it now and merge into the final return after waitForSettled (which polls
      // GET /v1/instances/:id, and GET strips the password).
      const created = (await api("/v1/instances", {
        method: "POST",
        body: { name, region, sizeId },
      })) as { _id: string; adminPassword?: string };
      try {
        const settled = await waitForSettled(created._id, "running", {
          onProgress,
        });
        return json({ ...settled, adminPassword: created.adminPassword });
      } catch (e: any) {
        throw new Error(
          `Instance ${created._id} WAS created but waiting for "running" failed: ${e?.message ?? e}. Do NOT call create_instance again — that would provision a duplicate. Initial adminPassword from the create response: "${created.adminPassword ?? "<not in response>"}" — surface it to the user before retrying anything. Call wait_for_instance_status(id="${created._id}") to keep waiting, or get_instance(id="${created._id}") to check the current state.`,
        );
      }
    },
  );

  server.tool(
    "rename_instance",
    "Rename an instance (display name only — does not affect host, port, credentials, or any client connections). Synchronous: returns the updated instance immediately.",
    {
      id: z.string().describe("The instance ID"),
      name: z.string().min(1).max(30).describe("New name (1–30 chars)"),
    },
    async ({ id, name }) =>
      json(
        await api(`/v1/instances/${id}`, {
          method: "PATCH",
          body: { name },
        }),
      ),
  );

  server.tool(
    "pause_instance",
    "Pause a running GQLDB instance. Blocks until the pause completes and the instance has fully settled in 'paused' (typically ~60s). Stops compute billing while paused (storage still billed).",
    { id: z.string().describe("The instance ID") },
    async ({ id }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/pause`, { method: "POST" });
      return json(await waitForSettled(id, "paused", { onProgress }));
    },
  );

  server.tool(
    "resume_instance",
    "Resume a paused GQLDB instance. Blocks until the resume completes and the instance is fully 'running' (typically 60–120s). Note: during resume, `status` stays 'paused' the whole time and only `progressStep` changes — that's expected.",
    { id: z.string().describe("The instance ID") },
    async ({ id }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/resume`, { method: "POST" });
      return json(await waitForSettled(id, "running", { onProgress }));
    },
  );

  server.tool(
    "restart_instance",
    "Restart a GQLDB instance. Blocks until the restart completes and the instance is back to 'running' (typically ~60s). Note: `status` stays 'running' for the whole restart — only `progressStep` changes.",
    { id: z.string().describe("The instance ID") },
    async ({ id }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/restart`, { method: "POST" });
      return json(await waitForSettled(id, "running", { onProgress }));
    },
  );

  server.tool(
    "upgrade_version",
    "Upgrade a GQLDB instance to the latest available version. Blocks until the upgrade completes and the instance is back to 'running' (can take several minutes; default timeout 5 min). Errors out with 409 if already on the latest version — call `get_latest_version` first and compare against the instance's current `version` if you want to avoid that.",
    { id: z.string().describe("The instance ID") },
    async ({ id }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/upgrade`, { method: "POST" });
      return json(
        await waitForSettled(id, "running", {
          onProgress,
          timeoutMs: 300_000,
        }),
      );
    },
  );

  server.tool(
    "delete_instance",
    "Delete an instance. Blocks until deletion fully completes upstream (status reaches 'deleted' or the instance is gone — typically 30–60s). Requires the instance name as a confirmation arg — must exactly match the current instance name, or the call is rejected without contacting the server.",
    {
      id: z.string().describe("The instance ID"),
      confirmName: z
        .string()
        .describe("Must exactly match the target instance's current name"),
    },
    async ({ id, confirmName }, extra) => {
      const onProgress = makeProgressReporter(extra);
      const inst = (await api(`/v1/instances/${id}`)) as { name?: string };
      if (inst?.name !== confirmName) {
        throw new Error(
          `confirmName mismatch: instance ${id} is named "${inst?.name}", but confirmName was "${confirmName}". Refusing to delete.`,
        );
      }
      await api(`/v1/instances/${id}`, { method: "DELETE" });
      await waitForSettled(id, "deleted", { onProgress });
      return json({ deleted: true, id, name: confirmName });
    },
  );

  server.tool(
    "reset_admin_password",
    "Rotate the admin DB password for an instance and return the new value. Uses the `instances:write` scope. WARNING: any existing apps / drivers / sessions using the old password will be broken until reconfigured. Only call this when the user explicitly asks to reset/rotate the password — do not call it as an automatic fallback for `get_instance_credentials`.",
    {
      id: z.string().describe("The instance ID"),
      password: z
        .string()
        .min(6)
        .max(128)
        .optional()
        .describe(
          "Optional new password (6–128 chars). If omitted, the server generates one.",
        ),
    },
    async ({ id, password }) =>
      json(
        await api(`/v1/instances/${id}/reset-password`, {
          method: "POST",
          body: password === undefined ? {} : { password },
        }),
      ),
  );

  server.tool(
    "set_log_level",
    "Set the GQLDB log level on an instance. Blocks until the change is applied (typically a few seconds). `status` stays 'running' throughout; only `progressStep` changes.",
    {
      id: z.string().describe("The instance ID"),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .describe("New log level"),
    },
    async ({ id, level }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/log-level`, {
        method: "POST",
        body: { level },
      });
      return json(await waitForSettled(id, "running", { onProgress }));
    },
  );

  // ── Recovery / explicit polling (rarely needed directly) ────────────────

  server.tool(
    "wait_for_instance_status",
    "Block until an instance settles into the target status (default 'running'). NOTE: you usually do NOT need to call this directly — `create_instance`, `pause_instance`, `resume_instance`, `restart_instance`, `upgrade_version`, `set_log_level`, and `delete_instance` all auto-wait internally. Use this only for explicit/manual polling (e.g. recovering from a half-known state, or waiting on an instance someone else triggered). An instance is 'in transition' whenever `progressStep` is non-empty OR `status` is one of `provisioning`/`upgrading`/`deleting`. Throws on `error` / `suspended` / `deleted`, on settling on any other non-target status, or on timeout.",
    {
      id: z.string().describe("The instance ID"),
      target: z
        .enum(["running", "paused"])
        .default("running")
        .describe(
          "Target status. Default 'running'. Use 'paused' after pause_instance.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .default(180_000)
        .describe(
          "Max time to wait, in milliseconds. Default 180000 (3 min). Resume / restart of larger instances can take 60–120s.",
        ),
      pollIntervalMs: z
        .number()
        .int()
        .positive()
        .default(3000)
        .describe("Polling interval, in milliseconds. Default 3000."),
    },
    async ({ id, target, timeoutMs, pollIntervalMs }, extra) => {
      const onProgress = makeProgressReporter(extra);
      return json(
        await waitForSettled(id, target, {
          timeoutMs,
          pollIntervalMs,
          onProgress,
        }),
      );
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";
import { waitForSettled, waitForBackup } from "../helpers/wait.js";
import { makeProgressReporter } from "../helpers/progress.js";

export function registerBackupTools(server: McpServer) {
  server.tool(
    "list_backups",
    "List all backups for an instance. Each backup has `_id`, `status` (`in_progress` | `completed` | `failed` | `restoring`), `createdAt`, and storage details.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) => json(await api(`/v1/instances/${id}/backups`)),
  );

  server.tool(
    "create_backup",
    "Trigger an on-demand backup of an instance. Blocks until the backup reaches `completed` (or throws on `failed`). Default timeout 10 min — large instances can take longer; raise via `timeoutMs` if needed.",
    {
      id: z.string().describe("The instance ID"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .default(600_000)
        .describe("Max wait, in milliseconds. Default 600000 (10 min)."),
    },
    async ({ id, timeoutMs }, extra) => {
      const onProgress = makeProgressReporter(extra);
      const backup = (await api(`/v1/instances/${id}/backups`, {
        method: "POST",
      })) as { _id: string };
      try {
        return json(
          await waitForBackup(id, backup._id, { timeoutMs, onProgress }),
        );
      } catch (e: any) {
        throw new Error(
          `Backup ${backup._id} WAS triggered on instance ${id} but waiting for "completed" failed: ${e?.message ?? e}. Do NOT call create_backup again — that would queue a duplicate backup. Call list_backups(id="${id}") to poll the current backup's status, or just wait and check again later.`,
        );
      }
    },
  );

  server.tool(
    "restore_backup",
    "Restore an instance from one of its completed backups. **Destructive: overwrites the instance's current data.** Blocks until the restore completes and the instance is back to 'running' (status stays 'running' throughout — only `progressStep` ('Restoring backup...') indicates the work). Default timeout 10 min.",
    {
      id: z.string().describe("The instance ID"),
      backupId: z
        .string()
        .describe(
          "The backup ID to restore from (must belong to this instance and have status 'completed')",
        ),
    },
    async ({ id, backupId }, extra) => {
      const onProgress = makeProgressReporter(extra);
      await api(`/v1/instances/${id}/restore`, {
        method: "POST",
        body: { backupId },
      });
      return json(
        await waitForSettled(id, "running", {
          onProgress,
          timeoutMs: 600_000,
        }),
      );
    },
  );

  server.tool(
    "set_backup_schedule",
    "Set or update an automated backup schedule on an instance. Synchronous; returns the updated instance. For `weekly`, `dayOfWeek` is required (0 = Sunday).",
    {
      id: z.string().describe("The instance ID"),
      frequency: z
        .enum(["daily", "weekly"])
        .describe("How often the backup should run"),
      UTC_hour: z
        .number()
        .int()
        .min(0)
        .max(23)
        .describe("Hour-of-day (UTC) at which to run, 0–23"),
      dayOfWeek: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe(
          "Day-of-week 0–6 (0 = Sunday). Required when frequency is 'weekly'.",
        ),
    },
    async ({ id, frequency, UTC_hour, dayOfWeek }) => {
      if (frequency === "weekly" && dayOfWeek === undefined) {
        throw new Error("dayOfWeek is required when frequency is 'weekly'.");
      }
      const body: Record<string, unknown> = { frequency, UTC_hour };
      if (dayOfWeek !== undefined) body.dayOfWeek = dayOfWeek;
      return json(
        await api(`/v1/instances/${id}/backup-schedule`, {
          method: "PUT",
          body,
        }),
      );
    },
  );

  server.tool(
    "delete_backup",
    "Permanently delete a specific backup from an instance. Synchronous. Requires `instances:delete` scope on the API key. Does NOT affect the instance itself — only removes the backup's stored snapshot. Irreversible.",
    {
      id: z.string().describe("The instance ID the backup belongs to"),
      backupId: z.string().describe("The backup ID to delete"),
    },
    async ({ id, backupId }) => {
      await api(`/v1/instances/${id}/backups/${backupId}`, {
        method: "DELETE",
      });
      return json({ deleted: true, instanceId: id, backupId });
    },
  );

  server.tool(
    "clear_backup_schedule",
    "Remove the automated backup schedule from an instance (existing backups are kept). Synchronous; returns the updated instance.",
    { id: z.string().describe("The instance ID") },
    async ({ id }) =>
      json(
        await api(`/v1/instances/${id}/backup-schedule`, { method: "DELETE" }),
      ),
  );
}

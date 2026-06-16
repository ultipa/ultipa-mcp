// Why two fields (status + progressStep)?
//
// Ultipa Cloud has no job API — state-change endpoints (resume, restart, etc.)
// return 200 immediately and the work continues in the background. The polling
// target is the instance object on /v1/instances/:id, but the transition
// signal requires reading BOTH:
//
//   - `status`: provisioning | running | paused | suspended | error |
//     deleting | upgrading | deleted. The first three are themselves
//     in-transition values.
//   - `progressStep`: a non-empty string ALWAYS means "in transition",
//     regardless of `status`.
//
// Gotcha: resume-from-paused keeps `status: 'paused'` for the entire op — the
// only signal it's in flight is `progressStep` (e.g. "Resuming instance...").
// Same pattern for restart and set_log_level (status stays 'running', only
// `progressStep` changes). Don't strip the `progressStep` guard thinking it's
// redundant with `status` — it isn't.
import { api } from "./api.js";

export const STATUS_IN_TRANSITION = new Set([
  "provisioning",
  "upgrading",
  "deleting",
]);

export type WaitOpts = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (
    step: string,
    status: string | undefined,
  ) => void | Promise<void>;
};

export async function waitForSettled(
  id: string,
  target: "running" | "paused" | "deleted",
  opts: WaitOpts = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    try {
      last = await api(`/v1/instances/${id}`);
    } catch (e) {
      if (target === "deleted" && String(e).includes("404")) {
        await opts.onProgress?.("Instance deleted.", "deleted");
        return { _id: id, status: "deleted" };
      }
      throw e;
    }
    const status: string | undefined = last?.status;
    const progressStep: string = last?.progressStep ?? "";
    const inTransition =
      progressStep !== "" ||
      (status ? STATUS_IN_TRANSITION.has(status) : false);
    if (!inTransition) {
      if (status === target) return last;
      if (status === "error" || status === "suspended") {
        throw new Error(
          `Instance ${id} settled on "${status}" (failure). Last state: ${JSON.stringify(last)}`,
        );
      }
      throw new Error(
        `Instance ${id} settled on "${status}", expected "${target}". Last state: ${JSON.stringify(last)}`,
      );
    }
    await opts.onProgress?.(
      progressStep || `Waiting for status "${target}"...`,
      status,
    );
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for instance ${id} to reach "${target}". Last status: "${last?.status}", progressStep: "${last?.progressStep ?? ""}".`,
  );
}

export async function waitForBackup(
  instanceId: string,
  backupId: string,
  opts: WaitOpts = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let backup: any = null;
  while (Date.now() < deadline) {
    const backups = (await api(`/v1/instances/${instanceId}/backups`)) as any[];
    backup = backups.find((b) => b?._id === backupId);
    if (!backup) {
      throw new Error(
        `Backup ${backupId} not found on instance ${instanceId} during wait.`,
      );
    }
    const status: string = backup.status;
    if (status === "completed") return backup;
    if (status === "failed") {
      throw new Error(
        `Backup ${backupId} failed. Last state: ${JSON.stringify(backup)}`,
      );
    }
    await opts.onProgress?.(`Backup ${status}...`, status);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for backup ${backupId} on instance ${instanceId}. Last status: "${backup?.status}".`,
  );
}

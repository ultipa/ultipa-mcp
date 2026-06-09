import { GqldbClient, ConfigBuilder } from "@ultipa-graph/ultipa-driver";
import { api } from "./api.js";
import {
  INSTANCE_HOST,
  INSTANCE_USER,
  INSTANCE_PASSWORD,
  hasModeA,
  hasModeB,
} from "./env.js";

// Data-plane client cache. Keys: "modeb" (env-configured single instance) or an instance ID
// (resolved via Mode A). Values are lazily-opened, logged-in GqldbClient promises.
const clientCache = new Map<string, Promise<GqldbClient>>();

async function buildDataPlaneClient(target: string): Promise<GqldbClient> {
  let host: string;
  let user: string;
  let password: string;

  if (target === "modeb") {
    host = INSTANCE_HOST!;
    user = INSTANCE_USER!;
    password = INSTANCE_PASSWORD!;
  } else {
    // Mode A: target is an instance ID. Resolve host + credentials via the Cloud control plane.
    const inst = (await api(`/v1/instances/${target}`)) as {
      status: string;
      host: string;
      port: number;
    };
    if (inst.status !== "running") {
      throw new Error(
        `Instance ${target} is not running (status: "${inst.status}"). Data-plane calls require a running instance.`,
      );
    }
    if (!inst.host || !inst.port) {
      throw new Error(
        `Instance ${target} has no reachable host/port (host="${inst.host}", port=${inst.port}).`,
      );
    }
    const creds = (await api(`/v1/instances/${target}/credentials`)) as {
      adminUser: string;
      adminPassword: string;
    };
    host = `${inst.host}:${inst.port}`;
    user = creds.adminUser;
    password = creds.adminPassword;
  }

  const cfg = new ConfigBuilder()
    .hosts(host)
    .username(user)
    .password(password)
    .timeoutSeconds(120)
    .build();
  const client = new GqldbClient(cfg);
  await client.login(user, password);
  return client;
}

export async function getDataPlaneClient(target: string): Promise<GqldbClient> {
  let pending = clientCache.get(target);
  if (!pending) {
    pending = buildDataPlaneClient(target);
    clientCache.set(target, pending);
    // On failure, drop the cache entry so the next call retries with a fresh build.
    pending.catch(() => clientCache.delete(target));
  }
  return pending;
}

export function resolveDataPlaneTarget(id: string | undefined): string {
  if (id) {
    if (!hasModeA) {
      throw new Error(
        "This call passed an `id`, which routes through Mode A (Cloud control plane), but ULTIPA_CLOUD_API_KEY is not configured. Either set it, or omit `id` to use the Mode B instance.",
      );
    }
    return id;
  }
  if (!hasModeB) {
    throw new Error(
      "No `id` provided and Mode B (ULTIPA_HOST + ULTIPA_USERNAME + ULTIPA_PASSWORD) is not configured. Pass `id` to target an instance via Mode A, or set the Mode B env vars to designate a default.",
    );
  }
  return "modeb";
}

export function serializeResponse(r: any) {
  // Convert the driver's Response into a clean JSON shape: column names, rows as objects
  // keyed by column name, plus row count. `toJSON()` on the SDK is typed as `string`, so
  // calling it would force the agent to parse a string out of the tool result — instead we
  // use `toObjects()` to project rows into a plain object array.
  if (r && typeof r === "object" && typeof r.toObjects === "function") {
    return {
      columns: r.columns,
      rows: r.toObjects(),
      rowCount: r.rowCount,
      rowsAffected: r.rowsAffected,
    };
  }
  return r;
}

export async function closeAllDataPlaneClients(): Promise<void> {
  const pending = [...clientCache.values()];
  clientCache.clear();
  await Promise.allSettled(
    pending.map((p) => p.then((c) => c.close()).catch(() => {})),
  );
}

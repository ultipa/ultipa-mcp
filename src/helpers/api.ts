import { API_KEY, BASE_URL } from "./env.js";

export async function api(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
) {
  if (!API_KEY) {
    throw new Error(
      "This tool needs Mode A (ULTIPA_CLOUD_API_KEY) but only Mode B is configured.",
    );
  }
  const { body, ...rest } = init;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...(rest.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, json } from "../helpers/api.js";

export function registerBillingTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get the account's current Ultipa Cloud balance and related billing flags. Useful as a pre-check before `create_instance` on paid sizes — a paid-tier create with `balance <= 0` will be rejected with HTTP 402.",
    {},
    async () => json(await api("/v1/billing/balance")),
  );

  server.tool(
    "list_transactions",
    "List the account's balance transactions (top-ups, charges, refunds, adjustments). Ordered by date.",
    {},
    async () => json(await api("/v1/billing/transactions")),
  );

  server.tool(
    "get_usage",
    "Return the usage-based billing summary for a month (per-instance breakdown of compute, storage, and data-transfer charges). Default: current month.",
    {
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe(
          "Month in `YYYY-MM` format, e.g. '2026-06'. Omit for current month.",
        ),
    },
    async ({ month }) =>
      json(
        await api(`/v1/billing/usage${month ? `?month=${month}` : ""}`),
      ),
  );

  server.tool(
    "get_payment_method",
    "Return the saved payment method on file (card brand, last4, expiry), or `null` if none. To add or change a card, the user must go to https://dbaas.ultipa.com → Billing — the Stripe card flow requires client-side Stripe.js and can't be driven via MCP.",
    {},
    async () => json(await api("/v1/billing/payment-method")),
  );

  server.tool(
    "get_auto_reload",
    "Return the account's auto-reload settings: `{ enabled, thresholdCents, targetCents }`. When enabled, the account auto-tops-up to `targetCents` whenever balance drops below `thresholdCents`, charging the saved payment method.",
    {},
    async () => json(await api("/v1/billing/auto-reload")),
  );

  server.tool(
    "topup_balance",
    "Top up the account's Cloud balance. If a saved payment method exists and the charge doesn't require 3D Secure, the balance is credited immediately and `clientSecret` will be null. If 3DS is required, or there's no saved card, `clientSecret` will be returned and the user must complete the payment at https://dbaas.ultipa.com → Billing (Stripe.js can't be driven from MCP). Either way, `paymentIntentId` is returned for tracking. **DO NOT retry on error** — the previous attempt may have charged the card. Call `list_transactions` first to check whether the top-up went through, then retry only if it's clearly absent.",
    {
      amountCents: z
        .number()
        .int()
        .min(500)
        .describe("Amount to top up, in cents. Minimum 500 ($5.00)."),
    },
    async ({ amountCents }) =>
      json(
        await api("/v1/billing/top-up", {
          method: "POST",
          body: { amountCents },
        }),
      ),
  );

  server.tool(
    "start_payment_method_setup",
    "Start a Stripe Checkout session for adding/replacing the saved payment method. Returns `{ url }` — give the URL to the user; they click it, complete card entry in their browser, and Stripe handles the rest. The new card becomes the default automatically. (For the inline-card flow used by the Cloud portal's own UI, use the portal — MCP can't drive inline Stripe.js.)",
    {
      returnPath: z
        .string()
        .optional()
        .describe(
          "Optional path on dbaas.ultipa.com to return to after setup (e.g. '/billing'). Defaults to the billing page.",
        ),
    },
    async ({ returnPath }) => {
      const body: Record<string, unknown> = {};
      if (returnPath !== undefined) body.returnPath = returnPath;
      return json(
        await api("/v1/billing/setup-session", {
          method: "POST",
          body,
        }),
      );
    },
  );

  server.tool(
    "set_auto_reload",
    "Update the account's auto-reload settings. Server validates: when `enabled` is true, `targetCents` must be > `thresholdCents`, `targetCents` must be ≥ 500 ($5.00), AND a saved payment method must exist (use `get_payment_method` to check first).",
    {
      enabled: z.boolean().describe("Turn auto-reload on or off"),
      thresholdCents: z
        .number()
        .int()
        .min(0)
        .describe("Trigger top-up when balance drops below this (in cents)"),
      targetCents: z
        .number()
        .int()
        .min(0)
        .describe(
          "Top up to this amount (in cents). Must be > thresholdCents and ≥ 500 when enabled.",
        ),
    },
    async ({ enabled, thresholdCents, targetCents }) =>
      json(
        await api("/v1/billing/auto-reload", {
          method: "PUT",
          body: { enabled, thresholdCents, targetCents },
        }),
      ),
  );
}

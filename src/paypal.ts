/**
 * Minimal PayPal REST client for the SANDBOX (adapted from Locus).
 * Credentials come from env only and are never logged or sent to the browser.
 * Every call is recorded as an ApiCall (op, HTTP status, PayPal debug id, ids)
 * so the UI and README can show exactly what hit PayPal.
 */
import crypto from "node:crypto";

const BASE = (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
const SANDBOX_OK = /^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(BASE);

export interface ApiCall {
  op: string; method: string; path: string; ok: boolean;
  httpStatus?: number; debugId?: string; id?: string; status?: string; error?: string; at: string;
}

let cached: { token: string; exp: number } | null = null;

export function paypalConfigured(): { ok: boolean; reason?: string } {
  if (!SANDBOX_OK) return { ok: false, reason: "PAYPAL_API_BASE is not the PayPal sandbox. Keyring only runs against sandbox." };
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return { ok: false, reason: "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env" };
  return { ok: true };
}

export class PayPalError extends Error {
  constructor(message: string, public httpStatus?: number, public debugId?: string, public issue?: string) { super(message); }
}

async function getToken(): Promise<string> {
  const cfg = paypalConfigured();
  if (!cfg.ok) throw new PayPalError(cfg.reason!);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new PayPalError(`OAuth failed (${d.error || r.status})`, r.status, r.headers.get("paypal-debug-id") || undefined);
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in ?? 300) * 1000 };
  return cached.token;
}

async function call(method: string, path: string, body?: unknown): Promise<{ data: any; status: number; debugId?: string }> {
  const token = await getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    Prefer: "return=representation", "PayPal-Request-Id": `keyring-${crypto.randomUUID()}`,
  };
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  const debugId = r.headers.get("paypal-debug-id") || data.debug_id || undefined;
  if (!r.ok) {
    const issue = data?.details?.[0]?.issue || data?.name;
    throw new PayPalError(`${data?.name || "PayPal error"}${issue && issue !== data?.name ? ` / ${issue}` : ""}: ${data?.details?.[0]?.description || data?.message || r.statusText}`, r.status, debugId, issue);
  }
  return { data, status: r.status, debugId };
}

export type Rec<T = any> = { ok: true; data: T; log: ApiCall } | { ok: false; error: PayPalError; log: ApiCall };

function rec(op: string, method: string, path: string, body: unknown, pick: (d: any) => { id?: string; status?: string }): Promise<Rec> {
  const at = () => new Date().toISOString();
  const logPath = path.replace(/\?.*$/, "");
  return call(method, path, body).then(
    (res) => ({ ok: true as const, data: res.data, log: { op, method, path: logPath, ok: true, httpStatus: res.status, debugId: res.debugId, ...pick(res.data), at: at() } }),
    (e: PayPalError) => ({ ok: false as const, error: e, log: { op, method, path: logPath, ok: false, httpStatus: e.httpStatus, debugId: e.debugId, error: e.message, at: at() } }),
  );
}

/** Sandbox test card details only. The full PAN is sent to PayPal and never stored by Keyring. */
export interface TestCard { number: string; expiry: string; name: string }

/** Step 1 of saving a card without a purchase: POST /v3/vault/setup-tokens */
export function createSetupToken(customerId: string, card: TestCard) {
  return rec("vault.create_setup_token", "POST", "/v3/vault/setup-tokens", {
    customer: { id: customerId },
    payment_source: { card: { number: card.number, expiry: card.expiry, name: card.name,
      billing_address: { address_line_1: "1 Demo Way", admin_area_2: "Miami", admin_area_1: "FL", postal_code: "33101", country_code: "US" } } },
  }, (d) => ({ id: d.id, status: d.status }));
}

/** Step 2: exchange the approved setup token for a long-lived payment token: POST /v3/vault/payment-tokens */
export function createPaymentToken(setupTokenId: string) {
  return rec("vault.create_payment_token", "POST", "/v3/vault/payment-tokens", {
    payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
  }, (d) => ({ id: d.id }));
}

/** GET /v3/vault/payment-tokens?customer_id=... (sandbox index lags ~15-30s after create) */
export function listPaymentTokens(customerId: string) {
  return rec("vault.list_payment_tokens", "GET", `/v3/vault/payment-tokens?customer_id=${encodeURIComponent(customerId)}&page_size=20`, undefined,
    (d) => ({ status: `${(d.payment_tokens || []).length} token(s)` }));
}

export function getPaymentToken(id: string) {
  return rec("vault.get_payment_token", "GET", `/v3/vault/payment-tokens/${encodeURIComponent(id)}`, undefined, (d) => ({ id: d.id }));
}

/** DELETE /v3/vault/payment-tokens/{id} */
export function deletePaymentToken(id: string) {
  return rec("vault.delete_payment_token", "DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(id)}`, undefined, () => ({ id, status: "DELETED" }));
}

/** Merchant-initiated charge on a vaulted card: POST /v2/checkout/orders with payment_source.card.vault_id */
export function chargeVaultedCard(opts: { vaultId: string; amount: number; description: string; merchant: string; recurring: boolean }) {
  return rec("orders.create_with_vault_id", "POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      description: opts.description.slice(0, 127),
      soft_descriptor: opts.merchant.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 22),
      amount: { currency_code: "USD", value: opts.amount.toFixed(2) },
    }],
    payment_source: { card: { vault_id: opts.vaultId,
      stored_credential: { payment_initiator: "MERCHANT", payment_type: opts.recurring ? "RECURRING" : "UNSCHEDULED", usage: "SUBSEQUENT" } } },
  }, (d) => ({ id: d.id, status: d.status }));
}

export async function pingPayPal(): Promise<{ ok: boolean; error?: string }> {
  try { await getToken(); return { ok: true }; } catch (e: any) { return { ok: false, error: e.message }; }
}

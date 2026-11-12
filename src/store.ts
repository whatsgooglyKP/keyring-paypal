import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths.js";
import type { ApiCall } from "./paypal.js";
import type { Recognition } from "./recognizer.js";
import type { Explanation } from "./ai.js";

export interface Card {
  id: string; merchantId: string; vaultCustomerId: string; paymentTokenId?: string;
  brand: string; last4: string; expiry: string;
  source: "paypal_vault" | "simulated"; simulatedReason?: string;
  tokenCreatedAt: string;      // real PayPal create_time (or local time if simulated)
  storySavedAt: string;        // backdated "saved" date for the demo story (synthetic)
  locked: boolean; lockedAt?: string; revokedAt?: string;
  vaultCheck?: { at: string; listed: boolean; via: "list" | "get" | "none"; note: string };
  paymentOptionId?: string;  // smart-checkout option (travel / cashback / ach) when this card is a boutique payment method
  productName?: string;      // fictional card product name (sandbox demo terms)
}
export interface Charge {
  id: string; cardId: string; merchantId: string; amount: number; description: string; at: string;
  source: "synthetic_history" | "paypal_sandbox" | "simulated";
  status: "completed" | "blocked" | "failed";
  recurring: boolean; blockedReason?: string; orderId?: string; captureId?: string; error?: string;
  paypalRejection?: ApiCall;    // proof: PayPal itself refusing a deleted token
  recognition?: Recognition;
  ai?: Explanation;              // cached Gemini (or template) explanation
  userConfirmedLegitimate?: boolean;  // set when the cardholder confirmed the purchase is legitimate at checkout
  paymentOptionId?: string;
  simulatedReason?: string;      // labeled simulation (e.g. ACH bank transfer)
}
export interface Consent { id: string; action: "lock" | "unlock" | "revoke"; cardId: string; at: string; acknowledgedSubscription?: boolean; via: "keyring_key" }
export interface Intent { id: string; cardId: string; action: "revoke"; expiresAt: number; warnings: string[]; requiresSubscriptionAck: boolean }
/**
 * Proactive alert: created automatically when a NEW charge on a saved card scores below the alert threshold.
 * The score comes only from the ML recognizer. Gemini (or the labeled template) explanation is attached afterwards.
 * An alert never acts: lock / revoke still go through the normal endpoints with the cardholder's confirmation.
 */
export interface Alert {
  id: string; chargeId: string; cardId: string; merchantId: string; merchantName: string; amount: number; description: string;
  card: string; chargeAt: string; createdAt: string;
  looksLikeYou: number; verdict: string; headline: string; threshold: number;
  status: "open" | "reviewed";            // reviewed = cardholder handled it (This was me / locked / revoked)
  resolution?: "this_was_me" | "locked" | "revoked"; resolvedAt?: string;
  read: boolean;                          // seen in the alerts list (drives the bell's unread count)
  aiPending: boolean; ai?: Explanation;
}
export interface State {
  keyring?: { handle: string; keyHash: string; createdAt: string };
  cards: Card[]; charges: Charge[]; consents: Consent[]; intents: Intent[]; apiLog: ApiCall[]; alerts: Alert[];
}

const FILE = path.join(DATA_DIR, "state.json");
const empty = (): State => ({ cards: [], charges: [], consents: [], intents: [], apiLog: [], alerts: [] });

export function load(): State {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return empty(); }
}
export function save(s: State) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  s.apiLog = s.apiLog.slice(-200);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, FILE);
}
export const id = (p: string) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Deterministic synthetic history (clearly labeled) so the recognizer has a baseline. */
export function syntheticHistory(card: Card, pattern: "monthly" | "coffee" | "dormant", subAmount?: number): Charge[] {
  let seed = [...card.id].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const now = Date.now(), DAY = 86400_000;
  const saved = new Date(card.storySavedAt).getTime();
  const mk = (t: number, amount: number, description: string, recurring: boolean): Charge => {
    const d = new Date(t); d.setUTCHours(13 + Math.floor(rand() * 8), Math.floor(rand() * 60), 0, 0); // 8am-4pm ET
    return { id: id("syn"), cardId: card.id, merchantId: card.merchantId, amount: Math.round(amount * 100) / 100, description, at: d.toISOString(),
      source: "synthetic_history", status: "completed", recurring };
  };
  const out: Charge[] = [];
  if (pattern === "monthly") {
    for (let t = now - 30 * DAY; t > saved; t -= 30 * DAY) out.push(mk(t, subAmount ?? 15.49, "Premium monthly (synthetic history)", true));
  } else if (pattern === "coffee") {
    for (let t = saved + DAY; t < now - 2 * DAY; t += DAY * (1 + Math.floor(rand() * 3))) out.push(mk(t, 4.5 + rand() * 4, "Coffee (synthetic history)", false));
  } else {
    const last = now - 425 * DAY;
    for (let t = last; t > saved; t -= 30 * DAY) out.push(mk(t, 39, "Membership (synthetic history)", true));
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

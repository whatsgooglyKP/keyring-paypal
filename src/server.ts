import "dotenv/config";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { PUBLIC_DIR } from "./paths.js";
import { MERCHANTS, merchantById, MAISON_VALE } from "./merchants.js";
import { metrics, modelInfo } from "./model.js";
import { recognize } from "./recognizer.js";
import { answerQuestion, explainCharge, recommendCheckout, type CardCtx, type ChargeCtx } from "./ai.js";
import { geminiConfigured, modelChain } from "./gemini.js";
import { id, load, save, sha256, syntheticHistory, type Alert, type Card, type Charge, type State } from "./store.js";
import {
  chargeVaultedCard, createPaymentToken, createSetupToken, deletePaymentToken, getPaymentToken,
  listPaymentTokens, paypalConfigured, pingPayPal, type ApiCall, type Rec, type TestCard,
} from "./paypal.js";
import { buildSmartCheckout, optionDef, PURCHASE, type PaymentOptionDef } from "./smart-checkout.js";

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const DAY = 86400_000;
const now = () => new Date().toISOString();
const log = (s: State, r: Rec) => { s.apiLog.push(r.log); return r; };
/** Treat auth/permission failures as "this API isn't available to the app" -> labeled local simulation. */
const isPermissionFailure = (r: Rec) => !r.ok && (r.log.httpStatus === 401 || r.log.httpStatus === 403 || /PERMISSION|NOT_AUTHORIZED|not configured|missing in \.env|OAuth/i.test(r.error.message));

// ---------- the customer's key ----------
/**
 * The key is a 256-bit random secret generated for the customer and shown ONCE; the server keeps only
 * its SHA-256. Merchants link a saved card to the customer's public handle (derived from the key), never
 * to an email or phone number. Demo simplification: the browser sends the key as a header. Production would
 * use a passkey (WebAuthn) signature per action instead of a bearer secret.
 */
function requireKey(req: Request, res: Response, next: NextFunction) {
  const s = load();
  const key = req.get("x-keyring-key") || "";
  if (!s.keyring || !key || sha256(key) !== s.keyring.keyHash) return res.status(401).json({ error: "Keyring key missing or wrong. Only the key holder can see or change saved cards." });
  next();
}

app.get("/api/status", async (_req, res) => {
  const cfg = paypalConfigured();
  const ping = cfg.ok ? await pingPayPal() : { ok: false, error: cfg.reason };
  const s = load();
  res.json({ paypal: { configured: cfg.ok, authOk: ping.ok, error: ping.error, env: "sandbox" }, keyring: s.keyring ? { handle: s.keyring.handle, createdAt: s.keyring.createdAt } : null,
    merchants: MERCHANTS.map(({ testCard, ...m }) => ({ ...m, testCardLast4: testCard.number.slice(-4) })), model: { ...modelInfo, metrics }, ai: { provider: "google-gemini", configured: geminiConfigured(), models: modelChain() }, alerts: { threshold: ALERT_THRESHOLD }, shop: { buttonLabel: PURCHASE.buttonLabel, amount: PURCHASE.amount, merchantName: PURCHASE.merchantName, productName: PURCHASE.productName, disclaimer: PURCHASE.disclaimer } });
});

app.post("/api/keyring", (_req, res) => {
  const s = load();
  if (s.keyring) return res.status(409).json({ error: "A Keyring already exists in this demo. Reset the demo to create a new one." });
  const key = `kr_${crypto.randomBytes(32).toString("base64url")}`;
  const handle = `krh_${sha256(`handle:${key}`).slice(0, 16)}`;
  s.keyring = { handle, keyHash: sha256(key), createdAt: now() };
  save(s);
  res.json({ key, handle, note: "Store this key. Keyring keeps only a hash of it and cannot show it again." });
});

// ---------- merchant side (simulated checkout pages) ----------
app.post("/api/merchants/:mid/save-card", async (req, res) => {
  const m = merchantById(req.params.mid);
  if (!m) return res.status(404).json({ error: "unknown merchant" });
  const s = load();
  if (!s.keyring || req.body?.handle !== s.keyring.handle) return res.status(400).json({ error: "Customer must opt in at checkout with their Keyring handle." });
  const existing = s.cards.find((c) => c.merchantId === m.id && !c.revokedAt);
  if (existing) return res.json({ card: existing, reused: true });

  // Each merchant keeps its own vault customer id, as real per-merchant vaults do.
  const vaultCustomerId = `kr-${m.id.slice(0, 6)}-${s.keyring.handle.slice(4, 14)}`; // PayPal caps customer.id at 22 chars
  const storySavedAt = new Date(Date.now() - m.history.monthsAgoSaved * 30 * DAY).toISOString();
  const card: Card = { id: id("card"), merchantId: m.id, vaultCustomerId, brand: "", last4: m.testCard.number.slice(-4), expiry: m.testCard.expiry,
    source: "paypal_vault", tokenCreatedAt: now(), storySavedAt, locked: false };

  const st = log(s, await createSetupToken(vaultCustomerId, m.testCard));
  let fail: Rec | undefined = st.ok ? undefined : st;
  if (st.ok) {
    const pt = log(s, await createPaymentToken(st.data.id));
    if (pt.ok) {
      card.paymentTokenId = pt.data.id;
      card.vaultCustomerId = pt.data.customer?.id || vaultCustomerId;
      card.brand = pt.data.payment_source?.card?.brand || "CARD";
      card.last4 = pt.data.payment_source?.card?.last_digits || card.last4;
      card.tokenCreatedAt = pt.data.create_time || card.tokenCreatedAt;
    } else fail = pt;
  }
  if (fail) {
    if (!isPermissionFailure(fail)) { save(s); return res.status(502).json({ error: `PayPal vault call failed: ${fail.log.op} ${fail.log.httpStatus ?? ""} ${fail.log.error}`, apiCall: fail.log }); }
    card.source = "simulated";
    card.simulatedReason = `${fail.log.method} ${fail.log.path} -> ${fail.log.httpStatus ?? "no response"}: ${fail.log.error}`;
    card.paymentTokenId = `sim_${crypto.randomBytes(6).toString("hex")}`;
    card.brand = m.testCard.number.startsWith("4") ? "VISA" : m.testCard.number.startsWith("5") ? "MASTERCARD" : "AMEX";
  }
  s.cards.push(card);
  s.charges.push(...syntheticHistory(card, m.history.pattern, m.subscription?.amount));
  save(s);
  res.json({ card, calls: s.apiLog.slice(-2) });
});

app.post("/api/merchants/:mid/charge", async (req, res) => {
  const m = merchantById(req.params.mid);
  if (!m) return res.status(404).json({ error: "unknown merchant" });
  const amount = Number(req.body?.amount);
  if (!(amount >= 0.5 && amount <= 5000)) return res.status(400).json({ error: "amount must be 0.50-5000" });
  const s = load();
  const card = [...s.cards].reverse().find((c) => c.merchantId === m.id);
  if (!card) return res.status(404).json({ error: `${m.name} has no saved card for this customer.` });
  const recurring = !!m.subscription && Math.abs(amount - m.subscription.amount) < 0.01;
  const ch: Charge = { id: id("chg"), cardId: card.id, merchantId: m.id, amount, description: String(req.body?.description || `${m.name} charge`).slice(0, 120),
    at: now(), source: card.source === "paypal_vault" ? "paypal_sandbox" : "simulated", status: "completed", recurring };

  if (card.revokedAt) {
    ch.status = "blocked";
    ch.blockedReason = `Blocked: you revoked this card at ${m.name} on ${new Date(card.revokedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET. The saved card no longer exists in the PayPal vault.`;
    // Proof that the block is real, not just our UI: ask PayPal to charge the deleted token anyway.
    if (card.source === "paypal_vault" && card.paymentTokenId) {
      const r = log(s, await chargeVaultedCard({ vaultId: card.paymentTokenId, amount, description: ch.description, merchant: m.name, recurring }));
      ch.paypalRejection = r.log;
      if (r.ok) ch.blockedReason += " WARNING: PayPal accepted the deleted token."; // should never happen; surfaced loudly if it does
    }
  } else if (card.locked) {
    ch.status = "blocked";
    ch.blockedReason = `Blocked: you locked this card at ${m.name}. Keyring stopped the charge before it reached PayPal. Unlock it in your Keyring to allow charges again.`;
  } else if (card.source === "paypal_vault") {
    const r = log(s, await chargeVaultedCard({ vaultId: card.paymentTokenId!, amount, description: ch.description, merchant: m.name, recurring }));
    if (r.ok) { ch.orderId = r.data.id; ch.captureId = r.data.purchase_units?.[0]?.payments?.captures?.[0]?.id; if (r.data.status !== "COMPLETED") ch.error = `Order status ${r.data.status}`; }
    else if (isPermissionFailure(r)) { ch.source = "simulated"; ch.error = `Simulated: ${r.log.method} ${r.log.path} -> ${r.log.httpStatus}: ${r.log.error}`; }
    else { ch.status = "failed"; ch.error = r.log.error; }
  }
  ch.recognition = recognize(ch, card, s.charges);
  s.charges.push(ch);
  // Proactive alert: decided by the ML score only, the moment the charge lands. Never locks or revokes anything.
  const alert = maybeCreateAlert(s, ch, card);
  save(s);
  if (alert) { broadcast("alert", { alert: alertView(alert), unread: unreadCount(s) }); void attachAlertExplanation(alert.id, req.body?.testForceAiFallback === true); }
  res.status(ch.status === "blocked" ? 403 : 200).json({ charge: ch, alertId: alert?.id ?? null });
});

// ---------- smart checkout (Maison Vale Boutique) ----------
app.get("/api/smart-checkout", (_req, res) => {
  res.json(buildSmartCheckout());
});

app.post("/api/smart-checkout/recommend", requireKey, async (req, res) => {
  const quote = buildSmartCheckout();
  const recommendation = await recommendCheckout(quote, { forceFallback: req.body?.forceFallback === true });
  res.json({ recommendation, executed: false });
});

/** Vault (or reuse) a boutique payment method. Bank transfer is a labeled local simulation. */
async function ensureBoutiquePayment(s: State, def: PaymentOptionDef): Promise<{ card: Card; hardFail?: { status: number; body: unknown } }> {
  const existing = s.cards.find((c) => c.merchantId === MAISON_VALE.id && c.paymentOptionId === def.id && !c.revokedAt);
  if (existing) return { card: existing };
  const prior = s.cards.find((c) => c.merchantId === MAISON_VALE.id && c.vaultCustomerId);
  const vaultCustomerId = prior?.vaultCustomerId || `kr-${MAISON_VALE.id.slice(0, 6)}-${s.keyring!.handle.slice(4, 14)}`;
  const card: Card = {
    id: id("card"), merchantId: MAISON_VALE.id, vaultCustomerId,
    brand: def.brand, last4: def.last4, expiry: def.testCard?.expiry || "",
    source: def.simulated ? "simulated" : "paypal_vault",
    simulatedReason: def.simulatedReason,
    tokenCreatedAt: now(), storySavedAt: now(), locked: false,
    paymentOptionId: def.id, productName: def.productName,
    paymentTokenId: def.simulated ? `sim_${crypto.randomBytes(6).toString("hex")}` : undefined,
  };
  if (def.simulated || !def.testCard) { s.cards.push(card); return { card }; }
  const testCard: TestCard = def.testCard;
  const st = log(s, await createSetupToken(vaultCustomerId, testCard));
  let fail: Rec | undefined = st.ok ? undefined : st;
  if (st.ok) {
    const pt = log(s, await createPaymentToken(st.data.id));
    if (pt.ok) {
      card.paymentTokenId = pt.data.id;
      card.vaultCustomerId = pt.data.customer?.id || vaultCustomerId;
      card.brand = pt.data.payment_source?.card?.brand || def.brand;
      card.last4 = pt.data.payment_source?.card?.last_digits || def.last4;
      card.tokenCreatedAt = pt.data.create_time || card.tokenCreatedAt;
    } else fail = pt;
  }
  if (fail) {
    if (!isPermissionFailure(fail)) {
      return { card, hardFail: { status: 502, body: { error: `PayPal vault call failed: ${fail.log.op} ${fail.log.httpStatus ?? ""} ${fail.log.error}`, apiCall: fail.log } } };
    }
    card.source = "simulated";
    card.simulatedReason = `${fail.log.method} ${fail.log.path} -> ${fail.log.httpStatus ?? "no response"}: ${fail.log.error}`;
    card.paymentTokenId = `sim_${crypto.randomBytes(6).toString("hex")}`;
  }
  s.cards.push(card);
  return { card };
}

app.post("/api/smart-checkout/pay", requireKey, async (req, res) => {
  if (req.body?.confirmedLegitimate !== true) return res.status(400).json({ error: "Confirm the purchase is legitimate to continue." });
  const def = optionDef(String(req.body?.optionId || ""));
  if (!def) return res.status(400).json({ error: "Select a payment option." });
  const s = load();
  const quote = buildSmartCheckout();
  const opt = quote.options.find((o) => o.id === def.id)!;
  const amount = quote.purchase.amount;
  const m = MAISON_VALE;
  const ensured = await ensureBoutiquePayment(s, def);
  if (ensured.hardFail) { save(s); return res.status(ensured.hardFail.status).json(ensured.hardFail.body); }
  const card = ensured.card;
  const description = `${m.name}: ${quote.purchase.productName} (${def.productName})`.slice(0, 120);
  const ch: Charge = {
    id: id("chg"), cardId: card.id, merchantId: m.id, amount, description, at: now(),
    source: def.simulated ? "simulated" : (card.source === "paypal_vault" ? "paypal_sandbox" : "simulated"),
    status: "completed", recurring: false, userConfirmedLegitimate: true, paymentOptionId: def.id,
    simulatedReason: def.simulated ? def.simulatedReason : (card.source === "simulated" ? card.simulatedReason : undefined),
  };

  if (card.revokedAt) {
    ch.status = "blocked";
    ch.blockedReason = `Blocked: you revoked this card at ${m.name} on ${new Date(card.revokedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET. The saved card no longer exists in the PayPal vault.`;
    if (card.source === "paypal_vault" && card.paymentTokenId) {
      const r = log(s, await chargeVaultedCard({ vaultId: card.paymentTokenId, amount, description, merchant: m.name, recurring: false }));
      ch.paypalRejection = r.log;
      if (r.ok) ch.blockedReason += " WARNING: PayPal accepted the deleted token.";
    }
  } else if (card.locked) {
    ch.status = "blocked";
    ch.blockedReason = `Blocked: you locked this card at ${m.name}. Keyring stopped the charge before it reached PayPal. Unlock it in your Keyring to allow charges again.`;
  } else if (def.simulated) {
    ch.source = "simulated";
    ch.simulatedReason = def.simulatedReason;
  } else if (card.source === "paypal_vault" && card.paymentTokenId) {
    const r = log(s, await chargeVaultedCard({ vaultId: card.paymentTokenId, amount, description, merchant: m.name, recurring: false }));
    if (r.ok) { ch.orderId = r.data.id; ch.captureId = r.data.purchase_units?.[0]?.payments?.captures?.[0]?.id; if (r.data.status !== "COMPLETED") ch.error = `Order status ${r.data.status}`; }
    else if (isPermissionFailure(r)) { ch.source = "simulated"; ch.error = `Simulated: ${r.log.method} ${r.log.path} -> ${r.log.httpStatus}: ${r.log.error}`; ch.simulatedReason = ch.error; }
    else { ch.status = "failed"; ch.error = r.log.error; }
  }

  ch.recognition = recognize(ch, card, s.charges);
  if (ch.recognition) {
    ch.recognition.facts.push("You confirmed this purchase is legitimate at checkout, so Keyring did not raise an alert.");
    ch.recognition.suggestion = "You confirmed this was you. No action needed.";
  }
  s.charges.push(ch);
  const alert = maybeCreateAlert(s, ch, card);
  save(s);
  if (alert) { broadcast("alert", { alert: alertView(alert), unread: unreadCount(s) }); void attachAlertExplanation(alert.id, req.body?.testForceAiFallback === true); }
  res.status(ch.status === "blocked" ? 403 : 200).json({ charge: ch, option: opt, alertId: alert?.id ?? null, benefits: opt.benefits });
});

// ---------- customer side (requires the key) ----------
function cardView(s: State, c: Card) {
  const m = merchantById(c.merchantId)!;
  const done = s.charges.filter((x) => x.cardId === c.id && x.status === "completed").sort((a, b) => a.at.localeCompare(b.at));
  const last = done[done.length - 1];
  const status = c.revokedAt ? "revoked" : c.locked ? "locked" : "active";
  return { ...c, merchant: { id: m.id, name: m.name, category: m.category, emoji: m.emoji }, status,
    lastCharge: last ? { at: last.at, amount: last.amount, source: last.source } : null,
    activeSubscription: !!m.subscription && !c.revokedAt ? m.subscription : null, chargeCount: done.length };
}

app.get("/api/key/cards", requireKey, (_req, res) => {
  const s = load();
  res.json({ cards: s.cards.map((c) => cardView(s, c)), consents: s.consents });
});

/** Re-read each merchant's vault from PayPal and mark which saved cards PayPal itself reports. */
app.post("/api/key/verify", requireKey, async (_req, res) => {
  const s = load();
  const live = s.cards.filter((c) => c.source === "paypal_vault" && !c.revokedAt);
  const byCustomer = new Map<string, Set<string>>();
  for (const cust of new Set(live.map((c) => c.vaultCustomerId))) {
    const r = log(s, await listPaymentTokens(cust));
    byCustomer.set(cust, new Set(r.ok ? (r.data.payment_tokens || []).map((t: any) => t.id) : []));
  }
  for (const c of live) {
    if (byCustomer.get(c.vaultCustomerId)?.has(c.paymentTokenId!)) { c.vaultCheck = { at: now(), listed: true, via: "list", note: "Listed by GET /v3/vault/payment-tokens?customer_id" }; continue; }
    const g = log(s, await getPaymentToken(c.paymentTokenId!));
    c.vaultCheck = g.ok
      ? { at: now(), listed: true, via: "get", note: "Found by GET /v3/vault/payment-tokens/{id}; customer list not indexed yet (sandbox lags ~15-30s)" }
      : { at: now(), listed: false, via: "get", note: `Not found in PayPal vault (${g.log.httpStatus})` };
  }
  save(s);
  res.json({ cards: s.cards.map((c) => cardView(s, c)) });
});

app.post("/api/key/cards/:cid/lock", requireKey, (req, res) => {
  const s = load();
  const c = s.cards.find((x) => x.id === req.params.cid);
  if (!c || c.revokedAt) return res.status(404).json({ error: "card not found or already revoked" });
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Explicit confirmation required (confirm: true)." });
  const lock = req.body?.locked !== false;
  c.locked = lock; c.lockedAt = lock ? now() : undefined;
  s.consents.push({ id: id("consent"), action: lock ? "lock" : "unlock", cardId: c.id, at: now(), via: "keyring_key" });
  const resolved = lock ? resolveAlertsForCard(s, c.id, "locked") : 0;
  save(s);
  if (resolved) broadcast("alerts", { unread: unreadCount(s) });
  res.json({ card: cardView(s, c) });
});

/** Revoke is two-step: the intent returns warnings; only an explicit confirm with the intent id deletes. */
app.post("/api/key/cards/:cid/revoke-intent", requireKey, (req, res) => {
  const s = load();
  const c = s.cards.find((x) => x.id === req.params.cid);
  if (!c || c.revokedAt) return res.status(404).json({ error: "card not found or already revoked" });
  const m = merchantById(c.merchantId)!;
  const warnings: string[] = [];
  if (m.subscription) warnings.push(`You have an active ${m.subscription.plan} subscription at ${m.name} ($${m.subscription.amount.toFixed(2)} every ${m.subscription.intervalDays} days). Revoking this card means the next renewal will fail. It does NOT cancel the subscription; cancel it with ${m.name} too if you want to stop the service.`);
  warnings.push(`${m.name} will have to ask you for a card again next time you buy.`);
  warnings.push(c.source === "paypal_vault" ? "This permanently deletes the saved card from the PayPal vault. It cannot be undone." : "This card is a local simulation; revoking deletes it locally.");
  const intent = { id: id("intent"), cardId: c.id, action: "revoke" as const, expiresAt: Date.now() + 5 * 60_000, warnings, requiresSubscriptionAck: !!m.subscription };
  s.intents = s.intents.filter((i) => i.expiresAt > Date.now()).concat(intent);
  save(s);
  res.json({ intent });
});

app.post("/api/key/cards/:cid/revoke", requireKey, async (req, res) => {
  const s = load();
  const c = s.cards.find((x) => x.id === req.params.cid);
  if (!c || c.revokedAt) return res.status(404).json({ error: "card not found or already revoked" });
  const intent = s.intents.find((i) => i.id === req.body?.intentId && i.cardId === c.id && i.expiresAt > Date.now());
  if (!intent || req.body?.confirm !== true) return res.status(400).json({ error: "Revoke needs a fresh revoke-intent and explicit confirm: true." });
  if (intent.requiresSubscriptionAck && req.body?.acknowledgeSubscription !== true) return res.status(400).json({ error: "This card pays an active subscription. Acknowledge the warning to revoke." });
  let call: ApiCall | undefined, verify: ApiCall | undefined;
  if (c.source === "paypal_vault") {
    const d = log(s, await deletePaymentToken(c.paymentTokenId!));
    call = d.log;
    if (!d.ok && d.log.httpStatus !== 404) { save(s); return res.status(502).json({ error: `PayPal refused the delete: ${d.log.error}`, apiCall: d.log }); }
    verify = log(s, await getPaymentToken(c.paymentTokenId!)).log; // expect 404
  }
  c.revokedAt = now(); c.locked = false;
  s.intents = s.intents.filter((i) => i.id !== intent.id);
  s.consents.push({ id: id("consent"), action: "revoke", cardId: c.id, at: now(), acknowledgedSubscription: req.body?.acknowledgeSubscription === true, via: "keyring_key" });
  if (resolveAlertsForCard(s, c.id, "revoked")) broadcast("alerts", { unread: unreadCount(s) });
  save(s);
  res.json({ card: cardView(s, c), deleteCall: call, verifyCall: verify });
});

app.get("/api/key/charges", requireKey, (_req, res) => {
  const s = load();
  const charges = [...s.charges].sort((a, b) => b.at.localeCompare(a.at)).map((c) => ({ ...c, recognition: undefined, ai: undefined, aiSource: c.ai?.source, verdict: c.recognition?.verdict, looksLikeYou: c.recognition?.looksLikeYou, merchantName: merchantById(c.merchantId)?.name }));
  res.json({ charges });
});

app.get("/api/key/charges/:id/explain", requireKey, (req, res) => {
  const s = load();
  const ch = s.charges.find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "charge not found" });
  const card = s.cards.find((c) => c.id === ch.cardId)!;
  const recognition = ch.recognition ?? recognize(ch, card, s.charges);
  res.json({ charge: { ...ch, recognition: undefined }, card: cardView(s, card), recognition });
});

// ---------- AI layer (Gemini explains; the ML model scores) ----------
const fmtET = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
function cardCtx(s: State, c: Card): CardCtx {
  const v = cardView(s, c);
  const amounts = s.charges.filter((x) => x.cardId === c.id && x.status === "completed").map((x) => x.amount).sort((a, b) => a - b);
  return { id: c.id, merchant: v.merchant.name, category: v.merchant.category, card: `${c.brand} ending ${c.last4}`, status: v.status as CardCtx["status"],
    savedAt: fmtET(c.storySavedAt), subscription: v.activeSubscription ? `${v.activeSubscription.plan} $${v.activeSubscription.amount.toFixed(2)} every ${v.activeSubscription.intervalDays} days` : null,
    lastCharge: v.lastCharge ? `$${v.lastCharge.amount.toFixed(2)} on ${fmtET(v.lastCharge.at)}` : null, completedCharges: v.chargeCount,
    usualAmount: amounts.length ? amounts[amounts.length >> 1] : null, historyNote: merchantById(c.merchantId)?.history.note ?? null };
}
function chargeCtx(ch: Charge): ChargeCtx {
  return { id: ch.id, cardId: ch.cardId, merchant: merchantById(ch.merchantId)?.name ?? ch.merchantId, amount: ch.amount, description: ch.description, at: fmtET(ch.at), status: ch.status,
    blockedReason: ch.blockedReason, userConfirmedLegitimate: ch.userConfirmedLegitimate, recognizer: ch.recognition ? { looksLikeYouPct: Math.round(ch.recognition.looksLikeYou * 100), verdict: ch.recognition.verdict, headline: ch.recognition.headline } : undefined };
}

/** Gemini explanation of one charge. Cached on the charge; ?refresh=1 (or body.refresh) asks again. Template fallback is labeled. */
app.post("/api/key/charges/:id/ai-explain", requireKey, async (req, res) => {
  const s = load();
  const ch = s.charges.find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "charge not found" });
  const card = s.cards.find((c) => c.id === ch.cardId)!;
  const rec = ch.recognition ?? recognize(ch, card, s.charges);
  const ctx = cardCtx(s, card);
  const force = req.body?.forceFallback === true;
  const fresh = force || req.body?.refresh === true || req.query.refresh === "1";
  // Reuse a cached Gemini answer only if the card's status hasn't changed since (allowed actions depend on it).
  if (!fresh && ch.ai?.source === "gemini" && ch.ai.cardStatus === ctx.status) return res.json({ ai: ch.ai, cached: true, recognition: { looksLikeYou: rec.looksLikeYou, verdict: rec.verdict, headline: rec.headline } });
  const ai = await explainCharge(chargeCtx(ch), rec, ctx, { forceFallback: force });
  if (force) return res.json({ ai, cached: false, recognition: { looksLikeYou: rec.looksLikeYou, verdict: rec.verdict, headline: rec.headline } });
  const s2 = load(); // re-load: another request may have written meanwhile
  const ch2 = s2.charges.find((c) => c.id === ch.id);
  if (ch2) { ch2.ai = { ...ai, cardStatus: ctx.status }; save(s2); }
  res.json({ ai, cached: false, recognition: { looksLikeYou: rec.looksLikeYou, verdict: rec.verdict, headline: rec.headline } });
});

/** Follow-up Q&A. Gemini may PROPOSE an action; the UI turns it into a button the cardholder must click and confirm. Nothing executes here. */
app.post("/api/key/ask", requireKey, async (req, res) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "question is required" });
  const s = load();
  const focusCh = req.body?.chargeId ? s.charges.find((c) => c.id === req.body.chargeId) : undefined;
  if (req.body?.chargeId && !focusCh) return res.status(404).json({ error: "charge not found" });
  const cards = s.cards.map((c) => cardCtx(s, c));
  const recent = s.charges.filter((c) => c.source !== "synthetic_history").sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25).map(chargeCtx);
  let focus;
  if (focusCh) { const card = s.cards.find((c) => c.id === focusCh.cardId)!; focus = { charge: chargeCtx(focusCh), recognizer: focusCh.recognition ?? recognize(focusCh, card, s.charges) }; }
  const answer = await answerQuestion(question, { cards, charges: recent, focus }, { forceFallback: req.body?.forceFallback === true });
  const target = answer.cardId ? cards.find((c) => c.id === answer.cardId) : undefined;
  res.json({ ...answer, card: target ? { id: target.id, merchant: target.merchant, card: target.card, status: target.status } : null, executed: false });
});

// ---------- proactive alerts ----------
/** "Looks like you" below this (0-1) creates an alert. ALERT_THRESHOLD accepts 0.5 or 50. Default 0.5. */
const ALERT_THRESHOLD = (() => { const v = Number(process.env.ALERT_THRESHOLD); return Number.isFinite(v) && v > 0 ? (v > 1 ? v / 100 : v) : 0.5; })();
const unreadCount = (s: State) => s.alerts.filter((a) => a.status === "open" && !a.read).length;
const alertView = (a: Alert) => ({ ...a, ai: a.ai ? { ...a.ai, attempts: a.ai.attempts } : undefined });

/** Only charges that actually went through are alerted (a blocked charge already didn't reach you). Synthetic history never alerts. */
function maybeCreateAlert(s: State, ch: Charge, card: Card): Alert | null {
  if (ch.status !== "completed" || ch.source === "synthetic_history" || !ch.recognition) return null;
  if (ch.userConfirmedLegitimate) return null; // cardholder already confirmed this purchase is legitimate at checkout
  if (ch.recognition.looksLikeYou >= ALERT_THRESHOLD) return null;
  const m = merchantById(ch.merchantId)!;
  const a: Alert = { id: id("alert"), chargeId: ch.id, cardId: card.id, merchantId: m.id, merchantName: m.name, amount: ch.amount, description: ch.description,
    card: `${card.brand} •••• ${card.last4}`, chargeAt: ch.at, createdAt: now(), looksLikeYou: ch.recognition.looksLikeYou, verdict: ch.recognition.verdict,
    headline: ch.recognition.headline, threshold: ALERT_THRESHOLD, status: "open", read: false, aiPending: true };
  s.alerts.push(a);
  return a;
}

/** Same Gemini path (with retry, model fallback, labeled template) as the charge drawer. Runs after the merchant's response. */
async function attachAlertExplanation(alertId: string, forceFallback = false) {
  try {
    const s = load();
    const a = s.alerts.find((x) => x.id === alertId); const ch = a && s.charges.find((c) => c.id === a.chargeId); const card = ch && s.cards.find((c) => c.id === ch.cardId);
    if (!a || !ch || !card) return;
    const ctx = cardCtx(s, card);
    const ai = await explainCharge(chargeCtx(ch), ch.recognition ?? recognize(ch, card, s.charges), ctx, { forceFallback });
    const s2 = load(); // re-load: the user may have acted (or reset) while Gemini was thinking
    const a2 = s2.alerts.find((x) => x.id === alertId);
    if (!a2) return;
    a2.ai = { ...ai, cardStatus: ctx.status }; a2.aiPending = false;
    const ch2 = s2.charges.find((c) => c.id === a2.chargeId);
    if (ch2 && ai.source === "gemini" && !forceFallback) ch2.ai = { ...ai, cardStatus: ctx.status };
    save(s2);
    broadcast("alert", { alert: alertView(a2), unread: unreadCount(s2) });
  } catch (e) {
    const s = load(); const a = s.alerts.find((x) => x.id === alertId);
    if (a) { a.aiPending = false; save(s); broadcast("alert", { alert: alertView(a), unread: unreadCount(s) }); }
    console.error("alert explanation failed:", (e as Error).message);
  }
}

/** When the cardholder locks or revokes (through the normal confirmed endpoints), their open alerts on that card are marked handled. */
function resolveAlertsForCard(s: State, cardId: string, how: "locked" | "revoked") {
  let n = 0;
  for (const a of s.alerts) if (a.cardId === cardId && a.status === "open") { a.status = "reviewed"; a.resolution = how; a.resolvedAt = now(); a.read = true; n++; }
  return n;
}

// Real-time push: Server-Sent Events over an authenticated fetch stream (the key travels in a header, never in a URL).
const streams = new Set<Response>();
function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of streams) r.write(msg);
}
setInterval(() => { for (const r of streams) r.write(": ping\n\n"); }, 20_000).unref();

app.get("/api/key/alerts/stream", requireKey, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ unread: unreadCount(load()), threshold: ALERT_THRESHOLD })}\n\n`);
  streams.add(res);
  req.on("close", () => streams.delete(res));
});

app.get("/api/key/alerts", requireKey, (_req, res) => {
  const s = load();
  res.json({ alerts: [...s.alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(alertView), unread: unreadCount(s), threshold: ALERT_THRESHOLD });
});

/** Mark alerts as seen (opening the alerts list). Does not resolve them. */
app.post("/api/key/alerts/read", requireKey, (req, res) => {
  const s = load();
  const ids: string[] | undefined = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  for (const a of s.alerts) if (!ids || ids.includes(a.id)) a.read = true;
  save(s);
  broadcast("alerts", { unread: unreadCount(s) });
  res.json({ unread: unreadCount(s) });
});

/** "This was me": marks the alert reviewed. The card is not touched. */
app.post("/api/key/alerts/:id/dismiss", requireKey, (req, res) => {
  const s = load();
  const a = s.alerts.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "alert not found" });
  if (a.status === "open") { a.status = "reviewed"; a.resolution = "this_was_me"; a.resolvedAt = now(); }
  a.read = true;
  save(s);
  broadcast("alert", { alert: alertView(a), unread: unreadCount(s) });
  res.json({ alert: alertView(a), unread: unreadCount(s) });
});

app.get("/api/key/api-log", requireKey, (_req, res) => res.json({ calls: [...load().apiLog].reverse() }));

/** Reset: deletes every still-active sandbox token we created, then clears local state. */
app.post("/api/demo/reset", async (_req, res) => {
  const s = load();
  const cleanup: ApiCall[] = [];
  for (const c of s.cards) if (c.source === "paypal_vault" && !c.revokedAt && c.paymentTokenId) cleanup.push((await deletePaymentToken(c.paymentTokenId)).log);
  save({ cards: [], charges: [], consents: [], intents: [], apiLog: [], alerts: [] });
  broadcast("reset", {});
  for (const c of streams) c.end(); // the old key is gone; open pages reconnect with the new key
  streams.clear();
  res.json({ ok: true, deletedSandboxTokens: cleanup.length });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  const cfg = paypalConfigured();
  console.log(`Keyring running on http://localhost:${port}  (PayPal sandbox ${cfg.ok ? "configured" : "NOT configured: " + cfg.reason})`);
});

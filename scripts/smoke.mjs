// End-to-end check against a running Keyring server: node scripts/smoke.mjs [baseUrl]
// Resets the demo (deletes its own sandbox tokens), then exercises every flow.
// Prints only PayPal resource ids and statuses, never credentials.
const BASE = process.argv[2] || process.env.KEYRING_URL || "http://localhost:3001";
let KEY = "";
const j = async (p, o = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (KEY && !o.noKey) headers["X-Keyring-Key"] = KEY;
  const r = await fetch(BASE + p, { method: o.method || "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const notes = [];

const st = await j("/api/status");
assert(st.data.paypal.authOk, "PayPal sandbox OAuth works");
await j("/api/demo/reset", { method: "POST" });
const kr = await j("/api/keyring", { method: "POST" });
assert(kr.status === 200 && kr.data.key && kr.data.handle, "customer key created (secret returned once)");
KEY = kr.data.key;
assert(/^krh_[0-9a-f]{16}$/.test(kr.data.handle), "handle is a hash-derived id (no email or phone number)");

// 1. Save cards at the merchants
const saved = {};
for (const mid of ["streamco", "beanbrew", "ironworks"]) {
  const r = await j(`/api/merchants/${mid}/save-card`, { method: "POST", body: { handle: kr.data.handle } });
  assert(r.status === 200 && r.data.card, `${mid}: card saved`);
  saved[mid] = r.data.card;
  console.log(`     ${mid.padEnd(10)} ${r.data.card.source.padEnd(13)} ${r.data.card.brand} ****${r.data.card.last4} token=${r.data.card.paymentTokenId} vaultCustomer=${r.data.card.vaultCustomerId}`);
  if (r.data.card.source === "simulated") notes.push(`${mid} save simulated: ${r.data.card.simulatedReason}`);
}
assert(saved.streamco.source === "paypal_vault" && saved.beanbrew.source === "paypal_vault", "both required merchants saved via the real PayPal vault");
assert(saved.streamco.vaultCustomerId !== saved.beanbrew.vaultCustomerId, "each merchant has its own vault customer id (per-merchant vaults)");

// Access control
const noKey = await j("/api/key/cards", { noKey: true });
assert(noKey.status === 401, "card list refused without the customer's key");

// 2. List
const list = await j("/api/key/cards");
assert(list.data.cards.length === 3, "Keyring lists all 3 saved cards across merchants");
const sc = list.data.cards.find((c) => c.merchantId === "streamco");
assert(sc.activeSubscription && sc.lastCharge, "StreamCo card shows active subscription and last charge");
const ver = await j("/api/key/verify", { method: "POST" });
const vc = ver.data.cards.filter((c) => c.source === "paypal_vault").map((c) => c.vaultCheck);
assert(vc.every((v) => v.listed), `PayPal vault confirms every real token (via: ${vc.map((v) => v.via).join(", ")})`);

// 3. Charges + 4. recognizer
const charge = (mid, amount, description) => j(`/api/merchants/${mid}/charge`, { method: "POST", body: { amount, description } });
// Live alert stream (SSE over fetch, key in a header). Collect events while the merchants charge.
const noKeyStream = await fetch(BASE + "/api/key/alerts/stream");
assert(noKeyStream.status === 401, "alert stream refused without the customer's key");
const streamEvents = [];
const streamCtl = new AbortController();
(async () => {
  try {
    const r = await fetch(BASE + "/api/key/alerts/stream", { headers: { "X-Keyring-Key": KEY }, signal: streamCtl.signal });
    const dec = new TextDecoder(); let buf = "";
    for await (const part of r.body) {
      buf += dec.decode(part, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (ev && data) streamEvents.push({ ev, data: JSON.parse(data) });
      }
    }
  } catch {}
})();
await new Promise((r) => setTimeout(r, 300));
const renew = await charge("streamco", 15.49, "Monthly renewal");
assert(renew.status === 200 && renew.data.charge.status === "completed" && renew.data.charge.orderId, `StreamCo renewal charged via Orders v2 vault_id (order ${renew.data.charge.orderId})`);
assert(renew.data.charge.recognition.verdict === "LOOKS_LIKE_YOU", `renewal: ${renew.data.charge.recognition.headline}`);
const latte = await charge("beanbrew", 6.25, "Latte");
assert(latte.data.charge.status === "completed" && latte.data.charge.recognition.verdict === "LOOKS_LIKE_YOU", `latte charged (order ${latte.data.charge.orderId}): ${latte.data.charge.recognition.headline}`);
const surprise = await j(`/api/merchants/streamco/charge`, { method: "POST", body: { amount: 89.99, description: "Annual upgrade", testForceAiFallback: true } });
assert(surprise.data.charge.recognition.verdict !== "LOOKS_LIKE_YOU", `surprise $89.99: ${surprise.data.charge.recognition.headline}`);
const gym = await charge("ironworks", 249, "Reactivation fee");
assert(gym.data.charge.recognition.verdict === "DOESNT_LOOK_LIKE_YOU", `dormant gym $249: ${gym.data.charge.recognition.headline}`);
// 4b. Proactive alerts: decided by the ML score alone, at the moment the charge lands.
const threshold = (await j("/api/key/alerts")).data.threshold;
assert(renew.data.alertId === null && latte.data.alertId === null, `high-scoring charges raise no alert (renewal ${Math.round(renew.data.charge.recognition.looksLikeYou * 100)}%, latte ${Math.round(latte.data.charge.recognition.looksLikeYou * 100)}%; threshold ${Math.round(threshold * 100)}%)`);
assert(typeof gym.data.alertId === "string", `gym $249 (${Math.round(gym.data.charge.recognition.looksLikeYou * 100)}%) raised an alert automatically, no click needed`);
assert(typeof surprise.data.alertId === "string", `surprise $89.99 (${Math.round(surprise.data.charge.recognition.looksLikeYou * 100)}%) raised an alert`);
const waitAlert = async (aid) => { for (let i = 0; i < 60; i++) { const a = (await j("/api/key/alerts")).data.alerts.find((x) => x.id === aid); if (a && !a.aiPending) return a; await new Promise((r) => setTimeout(r, 500)); } return null; };
const gymAlert = await waitAlert(gym.data.alertId);
assert(gymAlert && gymAlert.ai && ["gemini", "template"].includes(gymAlert.ai.source) && gymAlert.ai.explanation, `gym alert carries an explanation (source: ${gymAlert?.ai?.source}${gymAlert?.ai?.model ? ", " + gymAlert.ai.model : ""})`);
assert(gymAlert.looksLikeYou === gym.data.charge.recognition.looksLikeYou && gymAlert.status === "open" && gymAlert.merchantName === "IronWorks Gym" && gymAlert.amount === 249, "gym alert: merchant, amount, ML score, open");
if (gymAlert.ai.source !== "gemini") notes.push(`gym alert used template: ${gymAlert.ai.attempts.map((a) => `${a.model} ${a.httpStatus ?? ""} ${a.error}`).join("; ")}`);
console.log(`     alert [${gymAlert.ai.source}] ${gymAlert.ai.explanation}\n     -> ${gymAlert.ai.recommendedAction}`);
const surpriseAlert = await waitAlert(surprise.data.alertId);
assert(surpriseAlert?.ai?.source === "template" && surpriseAlert.ai.explanation && /forced fallback/.test(surpriseAlert.ai.attempts[0]?.error || ""), "alert still gets a labeled template explanation when Gemini is unavailable");
const alertsNow = (await j("/api/key/alerts")).data;
assert(alertsNow.alerts.length === 2 && alertsNow.unread === 2, "exactly 2 alerts, both unread (renewal + latte created none)");
await new Promise((r) => setTimeout(r, 300));
const pushed = streamEvents.filter((e) => e.ev === "alert");
assert(pushed.some((e) => e.data.alert.id === gym.data.alertId && e.data.alert.aiPending) && pushed.some((e) => e.data.alert.id === gym.data.alertId && !e.data.alert.aiPending), `alerts pushed live over SSE (${pushed.length} alert events: created, then explanation attached)`);
const cardsAfterAlert = (await j("/api/key/cards")).data.cards;
assert(cardsAfterAlert.find((c) => c.id === saved.ironworks.id).status === "active" && cardsAfterAlert.find((c) => c.id === saved.streamco.id).status === "active", "alerts never auto-execute: gym and StreamCo cards still active");
const dis = await j(`/api/key/alerts/${surprise.data.alertId}/dismiss`, { method: "POST" });
assert(dis.status === 200 && dis.data.alert.status === "reviewed" && dis.data.alert.resolution === "this_was_me" && dis.data.unread === 1, "'This was me' marks the alert reviewed (unread now 1)");
assert((await j("/api/key/cards")).data.cards.find((c) => c.id === saved.streamco.id).status === "active", "'This was me' doesn't touch the card");
assert((await j(`/api/key/alerts/nope/dismiss`, { method: "POST" })).status === 404 && (await j("/api/key/alerts", { noKey: true })).status === 401, "dismiss of unknown alert 404s; alerts list needs the key");

const ex = await j(`/api/key/charges/${gym.data.charge.id}/explain`);
assert(ex.data.recognition.facts.some((f) => /saved this card/.test(f)) && ex.data.recognition.facts.some((f) => /hadn't charged/.test(f)), "explanation covers when saved + dormancy");
console.log("     explanation:\n       - " + ex.data.recognition.facts.join("\n       - "));
const ex2 = await j(`/api/key/charges/${renew.data.charge.id}/explain`);
assert(ex2.data.recognition.facts.some((f) => /fits that cycle/.test(f)), "renewal explanation recognizes the recurring cycle");

// 5. AI layer: Gemini explains (or the labeled template does if Gemini is down); the score always comes from the ML model.
const ACTIONS = ["keep", "lock_card", "unlock_card", "revoke_card", "dispute"];
const aiGym = await j(`/api/key/charges/${gym.data.charge.id}/ai-explain`, { method: "POST", body: { refresh: true } });
const ag = aiGym.data.ai;
assert(aiGym.status === 200 && ["gemini", "template"].includes(ag?.source) && ag.explanation && ACTIONS.includes(ag.recommendedAction), `gym charge explained (source: ${ag?.source}${ag?.model ? ", " + ag.model : ""})`);
assert(aiGym.data.recognition.looksLikeYou === gym.data.charge.recognition.looksLikeYou, "AI layer leaves the ML score unchanged");
if (ag.source === "gemini") { if (ag.recommendedAction === "keep") notes.push("Gemini suggested keep for the dormant gym charge (unexpected, not a failure)"); else console.log(`ok   Gemini recommends ${ag.recommendedAction} for the dormant gym charge`); }
else notes.push(`Gemini unavailable for gym explain: ${ag.attempts.map((a) => `${a.model} ${a.httpStatus ?? ""} ${a.error}`).join("; ")}`);
console.log(`     [${ag.source}] ${ag.explanation}\n     -> ${ag.recommendedAction}: ${ag.actionReason}`);
const aiRenew = await j(`/api/key/charges/${renew.data.charge.id}/ai-explain`, { method: "POST", body: { refresh: true } });
assert(aiRenew.status === 200 && aiRenew.data.ai.explanation, `StreamCo renewal explained (source: ${aiRenew.data.ai.source}, action ${aiRenew.data.ai.recommendedAction})`);
if (aiRenew.data.ai.source === "gemini" && aiRenew.data.ai.recommendedAction !== "keep") notes.push(`Gemini suggested ${aiRenew.data.ai.recommendedAction} for the on-cycle renewal (unexpected, not a failure)`);
const fb = await j(`/api/key/charges/${gym.data.charge.id}/ai-explain`, { method: "POST", body: { forceFallback: true } });
assert(fb.data.ai.source === "template" && fb.data.ai.explanation && ACTIONS.includes(fb.data.ai.recommendedAction), "template fallback works when Gemini is unavailable");
const q = await j("/api/key/ask", { method: "POST", body: { chargeId: gym.data.charge.id, question: "Why did the gym charge me? Should I lock this card?" } });
assert(q.status === 200 && q.data.answer && q.data.executed === false, `follow-up answered (source: ${q.data.source}, proposes ${q.data.proposedAction})`);
console.log(`     Q&A [${q.data.source}] ${q.data.answer}`);
const stillActive = (await j("/api/key/cards")).data.cards.find((c) => c.id === saved.ironworks.id);
assert(stillActive.status === "active", "a proposed action is never auto-executed (gym card still active)");
const qfb = await j("/api/key/ask", { method: "POST", body: { chargeId: gym.data.charge.id, question: "why?", forceFallback: true } });
assert(qfb.data.source === "template" && qfb.data.proposedAction === "none" && qfb.data.answer, "Q&A template fallback works when Gemini is unavailable");

// Lock blocks
const lock = await j(`/api/key/cards/${saved.ironworks.id}/lock`, { method: "POST", body: { confirm: true } });
assert(lock.data.card.status === "locked", "customer locked the gym card");
const gymAfterLock = (await j("/api/key/alerts")).data.alerts.find((a) => a.id === gym.data.alertId);
assert(gymAfterLock.status === "reviewed" && gymAfterLock.resolution === "locked", "locking (through the normal confirmed endpoint) marks the gym alert handled");
const blocked = await charge("ironworks", 249, "Retry");
assert(blocked.status === 403 && blocked.data.charge.status === "blocked" && /locked/.test(blocked.data.charge.blockedReason), "charge on locked card blocked before PayPal");

// Revoke: needs intent + confirm + subscription ack
const noIntent = await j(`/api/key/cards/${saved.streamco.id}/revoke`, { method: "POST", body: { confirm: true } });
assert(noIntent.status === 400, "revoke without an intent is refused");
const intent = await j(`/api/key/cards/${saved.streamco.id}/revoke-intent`, { method: "POST" });
assert(intent.data.intent.requiresSubscriptionAck && /subscription/.test(intent.data.intent.warnings[0]), "revoke intent warns about the active subscription");
const noAck = await j(`/api/key/cards/${saved.streamco.id}/revoke`, { method: "POST", body: { intentId: intent.data.intent.id, confirm: true } });
assert(noAck.status === 400, "revoke without subscription acknowledgement is refused");
const rv = await j(`/api/key/cards/${saved.streamco.id}/revoke`, { method: "POST", body: { intentId: intent.data.intent.id, confirm: true, acknowledgeSubscription: true } });
assert(rv.status === 200 && rv.data.card.status === "revoked", "StreamCo card revoked with explicit consent");
assert(rv.data.deleteCall?.httpStatus === 204 && rv.data.verifyCall?.httpStatus === 404, `real PayPal DELETE /v3/vault/payment-tokens -> ${rv.data.deleteCall?.httpStatus}, GET afterwards -> ${rv.data.verifyCall?.httpStatus}`);
const after = await charge("streamco", 15.49, "Renewal after revoke");
assert(after.data.charge.status === "blocked", "charge on revoked card blocked");
const rej = after.data.charge.paypalRejection;
assert(rej && !rej.ok, `PayPal itself rejects the deleted token: ${rej?.httpStatus} ${rej?.error}`);
const cons = (await j("/api/key/cards")).data.consents;
assert(cons.length === 2 && cons.find((c) => c.action === "revoke").acknowledgedSubscription, "each lock/revoke recorded as a customer consent");

const blockedAlerts = (await j("/api/key/alerts")).data.alerts.length;
assert(blockedAlerts === 2, "blocked charges (locked/revoked card) raise no new alert");
streamCtl.abort();

// Reset clears alerts
await j("/api/demo/reset", { method: "POST" });
KEY = (await j("/api/keyring", { method: "POST" })).data.key;
const afterReset = (await j("/api/key/alerts")).data;
assert(afterReset.alerts.length === 0 && afterReset.unread === 0, "Reset demo clears alerts");

// Smart checkout: $2,450 designer dress with computed rewards and transfer fees
const quote = await j("/api/smart-checkout");
assert(quote.status === 200 && quote.data.purchase.amount === 2450, "smart checkout quote loads ($2,450.00 dress)");
assert(/Example reward terms \(sandbox demo\), not real card terms/.test(quote.data.purchase.disclaimer || quote.data.disclaimer), "disclaimer labels example demo terms");
const travel = quote.data.options.find((o) => o.id === "travel");
const cash = quote.data.options.find((o) => o.id === "cashback");
const ach = quote.data.options.find((o) => o.id === "ach");
assert(travel && travel.benefits.miles === 10000 && travel.benefits.estValue === 150 && travel.benefits.baseMiles === 9800, `travel: 4× × $2,450 + 200 promo = 10,000 miles, est. $${travel?.benefits.estValue}`);
assert(cash && cash.benefits.cashBack === 500 && cash.benefits.baseCashBack === 122.5, `cash back: 5% + $377.50 promo = $500.00 (got $${cash?.benefits.cashBack})`);
assert(ach && ach.benefits.fee === 0 && ach.benefits.savedVsCard === 71.35 && ach.simulated, `ACH: $0 fee, saves $71.35 vs card (got fee=${ach?.benefits.fee} saved=${ach?.benefits.savedVsCard})`);
assert(quote.data.transfer.cheapestFee === 0 && quote.data.transfer.savedVsCard === 71.35, "cheapest transfer is $0 ACH, saves $71.35 vs card");
assert(quote.data.transfer.routes.length === 4, "transfer comparison has card-to-card, card-to-merchant, bank-to-card, bank-to-merchant");
assert(quote.data.bestOptionId === "cashback", "highest dollar benefit is the cash-back card");
assert(/10,000/.test(travel.benefits.headline) && /\$150\.00/.test(travel.benefits.headline), `travel headline: ${travel.benefits.headline}`);
assert(/\$500\.00 cash back/.test(cash.benefits.headline), `cash headline: ${cash.benefits.headline}`);

const noPay = await j("/api/smart-checkout/pay", { method: "POST", body: { optionId: "cashback" } });
assert(noPay.status === 400, "pay refused without confirmedLegitimate");
const noOpt = await j("/api/smart-checkout/pay", { method: "POST", body: { confirmedLegitimate: true, optionId: "nope" } });
assert(noOpt.status === 400, "pay refused without a valid option");

const payCash = await j("/api/smart-checkout/pay", { method: "POST", body: { optionId: "cashback", confirmedLegitimate: true } });
assert(payCash.status === 200 && payCash.data.charge?.status === "completed" && payCash.data.charge.amount === 2450, `cash-back purchase completed ($${payCash.data.charge?.amount} ${payCash.data.charge?.status})`);
assert(payCash.data.charge.userConfirmedLegitimate === true, "charge is marked user-confirmed legitimate");
assert(payCash.data.alertId == null, "confirmed-legitimate purchase raises no alert");
assert(payCash.data.benefits.cashBack === 500, "pay response returns computed $500 cash back");
console.log(`     cashback   ${String(payCash.data.charge.source).padEnd(13)} order=${payCash.data.charge.orderId || "—"} ${payCash.data.option.productName}`);
if (payCash.data.charge.source === "simulated") notes.push(`smart-checkout cashback simulated: ${payCash.data.charge.simulatedReason || payCash.data.charge.error}`);

const payAch = await j("/api/smart-checkout/pay", { method: "POST", body: { optionId: "ach", confirmedLegitimate: true } });
assert(payAch.status === 200 && payAch.data.charge?.status === "completed" && payAch.data.charge.source === "simulated", "ACH purchase is a labeled simulation");
assert(/simulated/i.test(payAch.data.charge.simulatedReason || ""), `ACH simulatedReason: ${payAch.data.charge.simulatedReason}`);
assert(payAch.data.alertId == null, "ACH confirmed purchase raises no alert");
console.log(`     ach        simulated     ${payAch.data.option.productName}`);

const payTravel = await j("/api/smart-checkout/pay", { method: "POST", body: { optionId: "travel", confirmedLegitimate: true } });
assert(payTravel.status === 200 && payTravel.data.charge?.status === "completed" && payTravel.data.benefits.miles === 10000, "travel-card purchase completed with 10,000 miles");
console.log(`     travel     ${String(payTravel.data.charge.source).padEnd(13)} order=${payTravel.data.charge.orderId || "—"} ${payTravel.data.option.productName}`);
if (payTravel.data.charge.source === "simulated") notes.push(`smart-checkout travel simulated: ${payTravel.data.charge.simulatedReason || payTravel.data.charge.error}`);

const alertsAfterShop = (await j("/api/key/alerts")).data.alerts;
assert(alertsAfterShop.length === 0, `confirmed-legitimate boutique charges raise no alerts (got ${alertsAfterShop.length})`);
const cardsAfter = (await j("/api/key/cards")).data.cards.filter((c) => c.merchantId === "maisonvale");
assert(cardsAfter.length === 3, `boutique has three payment methods in Keyring (got ${cardsAfter.length})`);

const recTpl = await j("/api/smart-checkout/recommend", { method: "POST", body: { forceFallback: true } });
assert(recTpl.data.recommendation?.source === "template" && recTpl.data.executed === false, "recommendation template fallback, executed:false");
assert(/\$500\.00/.test(recTpl.data.recommendation.text) && /cash back/i.test(recTpl.data.recommendation.text), `template recommends cash back: ${recTpl.data.recommendation.text}`);

await j("/api/demo/reset", { method: "POST" });

if (notes.length) console.log("\nSimulated steps:\n  " + notes.join("\n  "));
console.log("\nSmoke test passed.");

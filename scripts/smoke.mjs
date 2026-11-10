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
assert(!/@|\d{7,}/.test(kr.data.handle), "handle contains no email or phone number");

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
const renew = await charge("streamco", 15.49, "Monthly renewal");
assert(renew.status === 200 && renew.data.charge.status === "completed" && renew.data.charge.orderId, `StreamCo renewal charged via Orders v2 vault_id (order ${renew.data.charge.orderId})`);
assert(renew.data.charge.recognition.verdict === "LOOKS_LIKE_YOU", `renewal: ${renew.data.charge.recognition.headline}`);
const latte = await charge("beanbrew", 6.25, "Latte");
assert(latte.data.charge.status === "completed" && latte.data.charge.recognition.verdict === "LOOKS_LIKE_YOU", `latte charged (order ${latte.data.charge.orderId}): ${latte.data.charge.recognition.headline}`);
const surprise = await charge("streamco", 89.99, "Annual upgrade");
assert(surprise.data.charge.recognition.verdict !== "LOOKS_LIKE_YOU", `surprise $89.99: ${surprise.data.charge.recognition.headline}`);
const gym = await charge("ironworks", 249, "Reactivation fee");
assert(gym.data.charge.recognition.verdict === "DOESNT_LOOK_LIKE_YOU", `dormant gym $249: ${gym.data.charge.recognition.headline}`);
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

if (notes.length) console.log("\nSimulated steps:\n  " + notes.join("\n  "));
console.log("\nSmoke test passed.");

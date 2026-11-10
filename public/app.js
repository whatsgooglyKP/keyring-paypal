const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TZ = "America/New_York";
const fmt = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }) + " ET";
const fmtD = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
const money = (n) => `$${Number(n).toFixed(2)}`;
const VERDICT = { LOOKS_LIKE_YOU: "Looks like you", NOT_SURE: "Not sure", DOESNT_LOOK_LIKE_YOU: "Doesn't look like you" };

let status = null;
const key = () => localStorage.getItem("keyring.key");
const handle = () => localStorage.getItem("keyring.handle");

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key()) headers["X-Keyring-Key"] = key();
  const r = await fetch(path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}
function toast(msg, kind = "") { const t = $("#toast"); t.hidden = false; t.className = `toast ${kind}`; t.innerHTML = msg; }

async function loadStatus() {
  status = (await api("/api/status")).data;
  const pp = $("#ppStatus");
  pp.textContent = status.paypal.authOk ? "PayPal sandbox: connected" : `PayPal sandbox: ${status.paypal.error || "not connected"}`;
  pp.className = `pill ${status.paypal.authOk ? "ok" : "bad"}`;
  if (status.keyring && status.keyring.handle !== handle()) { localStorage.removeItem("keyring.key"); localStorage.removeItem("keyring.handle"); }
  if (!status.keyring) { localStorage.removeItem("keyring.key"); localStorage.removeItem("keyring.handle"); }
  renderKey();
  renderMerchants();
  const mt = status.model.metrics || {};
  $("#footerMeta").innerHTML = `Charge recognizer: logistic regression on ${status.model.features.length} features, trained on <b>synthetic</b> data (held-out ROC AUC ${mt.roc_auc ?? "?"} on synthetic data, not real-world performance). ${status.ai?.configured ? `Plain-English explanations and answers by Google Gemini (${esc(status.ai.models.join(" → "))}), grounded only in the model's facts; the score always comes from the model, and a labeled template is used if Gemini is unavailable.` : "Gemini not configured: explanations are deterministic templates."} Saved-card history before today is synthetic and labeled as such. PayPal sandbox only. MIT license.`;
}

function renderKey() {
  const has = !!key();
  $("#createKey").hidden = has || !!status.keyring;
  $("#keyStatus").textContent = has ? `Key: ${handle()}` : status.keyring ? "Key held elsewhere" : "No key yet";
  $("#keyStatus").className = `pill ${has ? "ok" : ""}`;
  const info = $("#keyInfo");
  if (has) { info.hidden = false; info.innerHTML = `<span class="muted small">Public handle (what merchants see):</span><code>${esc(handle())}</code><span class="muted small">Secret key: stored only in this browser · server keeps a SHA-256 hash</span>`; }
  else if (status.keyring) { info.hidden = false; info.innerHTML = `<span class="muted">A key exists but isn't in this browser. Reset the demo to start over.</span>`; }
  else info.hidden = true;
}

function renderMerchants() {
  $("#merchants").innerHTML = status.merchants.map((m) => `
    <div class="merchant" data-m="${m.id}">
      <div><b>${m.emoji} ${esc(m.name)}</b><div class="cat">${esc(m.category)}${m.subscription ? ` · ${esc(m.subscription.plan)} ${money(m.subscription.amount)}/${m.subscription.intervalDays}d` : ""}</div></div>
      <button class="primary" data-save="${m.id}" ${key() ? "" : "disabled"}>Save card at checkout (•••• ${m.testCardLast4})</button>
      <div class="presets">${m.presets.map((p, i) => `<button class="ghost" data-charge="${m.id}" data-i="${i}" ${key() ? "" : "disabled"}>Merchant charges: ${esc(p.label)}</button>`).join("")}</div>
      <div class="pp-accept"><img src="/marks/pp_cc_mark_37x23.jpg" width="37" height="23" alt="PayPal Acceptance Mark"></div>
    </div>`).join("");
}

async function refresh() {
  if (!key()) { $("#cards").innerHTML = `<p class="muted">Create your key first.</p>`; $("#charges").innerHTML = ""; $("#apiLog").innerHTML = ""; return; }
  const [c, ch, lg] = await Promise.all([api("/api/key/cards"), api("/api/key/charges"), api("/api/key/api-log")]);
  renderCards(c.data.cards || []);
  cardsById = Object.fromEntries((c.data.cards || []).map((x) => [x.id, x]));
  renderAlerts();
  renderCharges(ch.data.charges || []);
  $("#apiLog").innerHTML = (lg.data.calls || []).map((x) => `<div><span class="m">${esc(fmt(x.at))}</span><span class="mono">${esc(x.method)} ${esc(x.path)}</span><span class="${x.ok ? "good" : "bad"}">${x.httpStatus ?? "-"}</span><span class="mono">${esc(x.id || "")} ${esc(x.status || "")} ${x.error ? `<span class="bad">${esc(x.error)}</span>` : ""} <span class="m">debug ${esc(x.debugId || "-")}</span></span></div>`).join("") || `<p class="muted">No calls yet.</p>`;
}

function renderCards(cards) {
  if (!cards.length) { $("#cards").innerHTML = `<p class="muted">No saved cards yet. Save a card at a merchant above.</p>`; return; }
  $("#cards").innerHTML = `<div class="row h"><span>Merchant</span><span>Card</span><span>Saved</span><span>Last charge</span><span>Subscription</span><span>Status</span><span>Actions</span></div>` +
    cards.map((c) => `<div class="row ${c.status}" data-card="${c.id}">
      <span>${c.merchant.emoji} <b>${esc(c.merchant.name)}</b><div class="m">${esc(c.merchant.category)}</div></span>
      <span>${esc(c.brand)} •••• ${esc(c.last4)}<div><span class="src ${c.source === "paypal_vault" ? "real" : "sim"}" title="${esc(c.simulatedReason || c.paymentTokenId || "")}">${c.source === "paypal_vault" ? "PayPal vault token" : "simulated"}</span></div>${c.vaultCheck ? `<div class="m">${c.vaultCheck.listed ? "✓ in PayPal vault" : "✗ not in vault"} (${esc(c.vaultCheck.via)})</div>` : ""}</span>
      <span>${fmtD(c.storySavedAt)}<div class="m" title="Real PayPal create_time of the sandbox token">token ${fmtD(c.tokenCreatedAt)}</div></span>
      <span>${c.lastCharge ? `${money(c.lastCharge.amount)}<div class="m">${fmtD(c.lastCharge.at)}</div>` : "—"}</span>
      <span>${c.activeSubscription ? `<span class="sub">● Active ${money(c.activeSubscription.amount)}/${c.activeSubscription.intervalDays}d</span>` : `<span class="m">None</span>`}</span>
      <span><span class="status ${c.status}">${c.status}</span></span>
      <span class="btns">${c.status === "revoked" ? `<span class="m">Revoked ${fmtD(c.revokedAt)}</span>` : `
        <button class="ghost" data-lock="${c.id}" data-locked="${c.locked}">${c.locked ? "Unlock" : "Lock"}</button>
        <button class="ghost danger" data-revoke="${c.id}">Revoke</button>`}</span>
    </div>`).join("");
}

function renderCharges(charges) {
  const shown = charges.filter((c) => c.source !== "synthetic_history").concat(charges.filter((c) => c.source === "synthetic_history").slice(0, 6));
  if (!shown.length) { $("#charges").innerHTML = `<p class="muted">No charges yet.</p>`; return; }
  const hidden = charges.length - shown.length;
  $("#charges").innerHTML = `<div class="row charge h"><span>When</span><span>Merchant</span><span>Amount</span><span>Result</span><span>Recognizer</span><span>Source</span></div>` +
    shown.map((c) => `<div class="row charge" data-charge-id="${c.id}">
      <span class="m">${fmt(c.at)}</span><span>${esc(c.merchantName)}<div class="m">${esc(c.description)}</div></span><span>${money(c.amount)}</span>
      <span><span class="status ${c.status}">${c.status}</span></span>
      <span>${c.verdict ? `<span class="badge ${c.verdict}">${VERDICT[c.verdict]} · ${Math.round(c.looksLikeYou * 100)}%</span>` : `<span class="m">Explain →</span>`}</span>
      <span>${c.source === "paypal_sandbox" ? `<span class="src real">PayPal ${esc(c.orderId || "")}</span>` : c.source === "simulated" ? `<span class="src sim">simulated</span>` : `<span class="src">synthetic history</span>`}</span>
    </div>`).join("") + (hidden > 0 ? `<p class="muted small">+ ${hidden} older synthetic-history charges (baseline for the recognizer).</p>` : "");
}

async function openCharge(id) {
  const r = await api(`/api/key/charges/${id}/explain`);
  if (!r.ok) return toast(esc(r.data.error), "err");
  const { charge: c, card, recognition: g } = r.data;
  $("#drawerContent").innerHTML = `
    <p class="muted small">I don't recognize this charge</p>
    <h2 style="margin:0">${money(c.amount)} · ${esc(card.merchant.name)}</h2>
    <p class="muted">${fmt(c.at)} · <span class="status ${c.status}">${c.status}</span></p>
    ${c.blockedReason ? `<div class="warn">${esc(c.blockedReason)}${c.paypalRejection ? `<div class="m">PayPal check on the deleted token: ${esc(c.paypalRejection.method)} ${esc(c.paypalRejection.path)} → ${c.paypalRejection.httpStatus} ${esc(c.paypalRejection.error || "")}</div>` : ""}</div>` : ""}
    <div class="verdict ${g.verdict}"><div class="big">${esc(g.headline)}</div><div class="meter"><i style="width:${Math.round(g.looksLikeYou * 100)}%"></i></div><div class="m" style="margin-top:6px">Score: Keyring's fraud model (logistic regression)</div>
      <div id="aiExplain" class="ai loading"><span class="ai-src">Asking Gemini…</span><p class="muted">Writing a plain-English explanation from the facts below.</p></div></div>
    <div class="card ask"><h3>Ask about this charge</h3>
      <form id="askForm" data-charge="${esc(c.id)}"><input id="askInput" maxlength="500" placeholder="e.g. Why did ${esc(card.merchant.name)} charge me?" autocomplete="off"><button class="primary" type="submit">Ask</button></form>
      <div class="chips"><button class="ghost chip" data-q="Why did ${esc(card.merchant.name)} charge me?">Why did ${esc(card.merchant.name)} charge me?</button><button class="ghost chip" data-q="Should I lock this card?">Should I lock this card?</button><button class="ghost chip" data-q="What happens to my subscription if I revoke this card?">What if I revoke it?</button></div>
      <div id="askOut"></div></div>
    <div class="card"><h3>What we know</h3><ul>${g.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>
    <div class="card"><h3>Model's top reasons</h3><ul>${g.topReasons.map((t) => `<li>${t.direction === "you" ? "✓ looks like you" : "⚠ not like you"}: ${esc(t.label)} <span class="m">(${t.impact > 0 ? "+" : ""}${t.impact})</span></li>`).join("") || "<li>No strong signals.</li>"}</ul>
      <p class="m">Logistic regression trained on synthetic data. These facts and reasons are deterministic; Gemini only rewrites them in plain English.</p></div>
    <div class="card"><h3>Card</h3><div class="kv">
      <span>Card</span><span>${esc(card.brand)} •••• ${esc(card.last4)}</span>
      <span>Saved at merchant</span><span>${fmtD(card.storySavedAt)} <span class="m">(story date; sandbox token created ${fmt(card.tokenCreatedAt)})</span></span>
      <span>Vault token</span><span class="mono">${esc(card.paymentTokenId)}</span>
      <span>PayPal order</span><span class="mono">${esc(c.orderId || "—")} ${c.captureId ? `/ capture ${esc(c.captureId)}` : ""}</span>
      <span>Status</span><span>${esc(card.status)}</span></div>
      ${card.status === "active" ? `<div class="btns" style="margin-top:10px"><button class="ghost" data-lock="${card.id}" data-locked="false">Lock this card</button><button class="ghost danger" data-revoke="${card.id}">Revoke this card</button></div>` : ""}
    </div>`;
  $("#drawerContent").dataset.view = "charge";
  $("#drawer").hidden = false;
  loadAiExplain(c.id, card);
}

const ACTION = { keep: "Keep it", lock_card: "Lock this card", unlock_card: "Unlock this card", revoke_card: "Revoke this card", dispute: "Dispute the charge" };
const srcLabel = (a, verb = "Explained") => a.source === "gemini" ? `<span class="ai-src gem">✦ ${verb} by Gemini <span class="m">${esc(a.model || "")}</span></span>` : `<span class="ai-src tpl">Template fallback <span class="m">Gemini unavailable${a.attempts?.length ? ` (${esc(a.attempts.map((x) => `${x.model}: ${x.httpStatus ?? ""} ${x.error || "ok"}`).join("; ").slice(0, 140))})` : ""}</span></span>`;
/** Turn a suggested action into a button. Nothing runs until the cardholder clicks it and confirms. */
function actionButton(action, card) {
  if (!card || !action || action === "none") return "";
  if (action === "keep") return `<div class="m">Suggested: keep it. No action needed.</div>`;
  if (action === "dispute") return `<div class="m">Suggested: dispute it with your card issuer or through PayPal. Keyring doesn't file disputes for you.</div>`;
  const attr = action === "revoke_card" ? `data-revoke="${esc(card.id)}" class="ghost danger"` : `data-lock="${esc(card.id)}" data-locked="${action === "unlock_card"}" class="ghost"`;
  return `<div class="btns" style="margin-top:8px"><button ${attr}>${ACTION[action]}${card.merchant ? ` at ${esc(typeof card.merchant === "string" ? card.merchant : card.merchant.name)}` : ""}</button><span class="m" style="align-self:center">Suggested · you confirm</span></div>`;
}

async function loadAiExplain(chargeId, card) {
  const r = await api(`/api/key/charges/${chargeId}/ai-explain`, { method: "POST", body: {} });
  const el = $("#aiExplain");
  if (!el) return;
  el.classList.remove("loading");
  if (!r.ok) { el.innerHTML = `<span class="ai-src tpl">AI explanation failed</span><p>${esc(r.data.error || "")}</p>`; return; }
  const a = r.data.ai;
  el.dataset.source = a.source;
  el.innerHTML = `${srcLabel(a)}<p>${esc(a.explanation)}</p><p class="small"><b>Recommended: ${ACTION[a.recommendedAction] || esc(a.recommendedAction)}.</b> ${esc(a.actionReason)}</p>${["lock_card", "unlock_card", "revoke_card"].includes(a.recommendedAction) ? actionButton(a.recommendedAction, card) : ""}`;
}

async function ask(chargeId, question) {
  const out = $("#askOut");
  if (!question.trim()) return;
  out.innerHTML = `<div class="answer loading"><b>You:</b> ${esc(question)}<p class="muted">Thinking…</p></div>`;
  const r = await api("/api/key/ask", { method: "POST", body: { question, chargeId } });
  if (!r.ok) { out.innerHTML = `<div class="answer"><span class="bad">${esc(r.data.error || "failed")}</span></div>`; return; }
  const a = r.data;
  out.innerHTML = `<div class="answer" data-source="${a.source}"><div class="m"><b>You:</b> ${esc(question)}</div>${srcLabel(a, "Answered")}<p>${esc(a.answer)}</p>${actionButton(a.proposedAction, a.card)}</div>`;
}

async function lockCard(id, currentlyLocked) {
  const lock = !currentlyLocked;
  if (!confirm(lock ? "Lock this card? The merchant won't be able to charge it until you unlock it." : "Unlock this card and allow charges again?")) return;
  const r = await api(`/api/key/cards/${id}/lock`, { method: "POST", body: { confirm: true, locked: lock } });
  toast(r.ok ? `${lock ? "🔒 Locked" : "Unlocked"}: ${esc(r.data.card.merchant.name)} •••• ${esc(r.data.card.last4)}. Recorded as your consent.` : esc(r.data.error), r.ok ? "ok" : "err");
  $("#drawer").hidden = true; refresh();
}

async function revokeCard(id) {
  const r = await api(`/api/key/cards/${id}/revoke-intent`, { method: "POST" });
  if (!r.ok) return toast(esc(r.data.error), "err");
  const it = r.data.intent;
  $("#modalContent").innerHTML = `<h2 style="margin-top:0">Revoke this saved card?</h2>
    ${it.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
    ${it.requiresSubscriptionAck ? `<label class="ack"><input type="checkbox" id="ack"> I understand my subscription renewal will fail.</label>` : ""}
    <div class="btns" style="margin-top:12px"><button class="bad" id="doRevoke" ${it.requiresSubscriptionAck ? "disabled" : ""}>Yes, revoke it</button><button class="ghost" data-close>Cancel</button></div>`;
  $("#modal").hidden = false;
  $("#ack")?.addEventListener("change", (e) => { $("#doRevoke").disabled = !e.target.checked; });
  $("#doRevoke").onclick = async () => {
    const d = await api(`/api/key/cards/${id}/revoke`, { method: "POST", body: { intentId: it.id, confirm: true, acknowledgeSubscription: !!$("#ack")?.checked } });
    $("#modal").hidden = true; $("#drawer").hidden = true;
    toast(d.ok ? `Revoked ${esc(d.data.card.merchant.name)} •••• ${esc(d.data.card.last4)}. ${d.data.deleteCall ? `PayPal vault: DELETE → ${d.data.deleteCall.httpStatus}; GET afterwards → ${d.data.verifyCall?.httpStatus}.` : "(simulated card)"}` : esc(d.data.error), d.ok ? "ok" : "err");
    refresh();
  };
}


// ---------- proactive alerts ----------
// A new charge that Keyring's model scores below the alert threshold raises an alert on the server the moment it lands.
// The page gets it in real time (Server-Sent Events over an authenticated fetch stream; polling if the stream drops),
// shows a banner + bell, and fires a desktop notification if the user allowed it. Alerts never act on their own.
let alerts = [];
let cardsById = {};
let alertThreshold = 0.5;
const seenAlerts = new Set();
let streamLive = false, streamCtl = null;
const hiddenBanners = () => new Set(JSON.parse(sessionStorage.getItem("keyring.hiddenBanners") || "[]"));
const hideBanner = (id) => { const h = hiddenBanners(); h.add(id); sessionStorage.setItem("keyring.hiddenBanners", JSON.stringify([...h])); };
const RESOLUTION = { this_was_me: "You marked this as you (This was me). The card was not changed.", locked: "You locked this card. New charges at this merchant are blocked.", revoked: "You revoked this card. It was deleted from the merchant's PayPal vault." };

function alertHtml(a, where) {
  const pct = Math.round(a.looksLikeYou * 100);
  const card = cardsById[a.cardId];
  const cardStatus = card?.status || "active";
  const ai = a.ai;
  const aiHtml = a.aiPending
    ? `<div class="ai loading"><span class="ai-src">Asking Gemini…</span><p class="muted">Writing a plain-English explanation from the model's facts.</p></div>`
    : ai ? `<div class="ai">${srcLabel(ai)}<p>${esc(ai.explanation)}</p><p class="small"><b>Recommended: ${ACTION[ai.recommendedAction] || esc(ai.recommendedAction)}.</b> ${esc(ai.actionReason)}</p></div>` : "";
  const open = a.status === "open";
  const btns = open ? `<div class="btns alert-actions">
      ${cardStatus === "active" ? `<button class="primary" data-lock="${esc(a.cardId)}" data-locked="false">Lock card</button>` : cardStatus === "locked" ? `<span class="status locked">card locked</span>` : ""}
      ${cardStatus !== "revoked" ? `<button class="ghost danger" data-revoke="${esc(a.cardId)}">Revoke card</button>` : ""}
      <button class="ghost" data-dismiss="${esc(a.id)}">This was me</button>
      <button class="ghost" data-charge-id="${esc(a.chargeId)}">View charge</button>
      ${where === "banner" ? `<span class="m">Nothing happens until you choose. Lock and revoke ask you to confirm.</span>` : ""}
    </div>` : `<p class="resolved">✓ ${esc(RESOLUTION[a.resolution] || "Reviewed.")} <button class="ghost chip" data-charge-id="${esc(a.chargeId)}">View charge</button></p>`;
  return `<div class="alert-item ${open ? "open" : "reviewed"}" data-alert="${esc(a.id)}">
    <div class="alert-title"><span class="alert-icon" aria-hidden="true">⚠</span><div><b>Suspicious charge: ${esc(a.merchantName)} charged ${money(a.amount)}</b>
      <div class="m">${esc(a.card)} · ${esc(fmt(a.chargeAt))} · ${esc(a.description)}</div></div></div>
    <div class="alert-score"><span class="badge ${esc(a.verdict)}">${VERDICT[a.verdict] || esc(a.verdict)} · ${pct}%</span><span class="m">Score from Keyring's fraud model. Alerts fire under ${Math.round(a.threshold * 100)}% "looks like you".</span></div>
    ${aiHtml}${btns}</div>`;
}

function renderBell() {
  const unread = alerts.filter((a) => a.status === "open" && !a.read).length;
  const b = $("#bell");
  b.hidden = !key();
  b.setAttribute("aria-label", `Alerts, ${unread} unread`);
  $("#bellCount").hidden = unread === 0;
  $("#bellCount").textContent = String(unread);
  const n = $("#enableNotif");
  if (!key() || !("Notification" in window)) n.hidden = true;
  else if (Notification.permission === "default") { n.hidden = false; n.disabled = false; n.textContent = "Enable desktop alerts"; }
  else if (Notification.permission === "granted") { n.hidden = false; n.disabled = true; n.textContent = "Desktop alerts on"; }
  else { n.hidden = false; n.disabled = true; n.textContent = "Desktop alerts blocked in browser"; }
}

function renderBanner() {
  const el = $("#alertBanner");
  const hidden = hiddenBanners();
  const open = alerts.filter((a) => a.status === "open" && !hidden.has(a.id));
  if (!key() || !open.length) { el.hidden = true; el.innerHTML = ""; return; }
  const a = open[0];
  el.innerHTML = `<div class="alert-banner-inner"><button class="close" data-hide-banner="${esc(a.id)}" aria-label="Hide this banner (the alert stays in the bell)">×</button>
    <p class="alert-kicker">Keyring alert · new charge doesn't look like you</p>${alertHtml(a, "banner")}
    ${open.length > 1 ? `<button class="ghost chip" data-open-alerts>+ ${open.length - 1} more open alert${open.length > 2 ? "s" : ""}</button>` : ""}</div>`;
  el.hidden = false;
}

function renderAlertsList() {
  const dc = $("#drawerContent");
  if ($("#drawer").hidden || dc.dataset.view !== "alerts") return;
  dc.innerHTML = `<p class="muted small">Suspicious-charge alerts</p><h2 style="margin:0 0 4px">Alerts</h2>
    <p class="muted small">Keyring raises an alert when a new charge scores under ${Math.round(alertThreshold * 100)}% "looks like you". It never locks or revokes on its own.</p>
    ${alerts.length ? alerts.map((a) => alertHtml(a, "list")).join("") : `<p class="muted">No alerts yet. Charges that look like you don't raise one.</p>`}`;
}

function renderAlerts() { renderBell(); renderBanner(); renderAlertsList(); }

async function openAlerts() {
  $("#drawerContent").dataset.view = "alerts";
  $("#drawer").hidden = false;
  renderAlertsList();
  if (alerts.some((a) => !a.read)) { await api("/api/key/alerts/read", { method: "POST", body: {} }); alerts.forEach((a) => (a.read = true)); renderBell(); }
}

function notifyDesktop(a) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(`Keyring: ${a.merchantName} charged ${money(a.amount)}`, { body: `${VERDICT[a.verdict] || a.verdict} (${Math.round(a.looksLikeYou * 100)}% looks like you) on ${a.card}. Open Keyring to lock, revoke, or mark "This was me".`, tag: a.id });
    n.onclick = () => { window.focus(); openAlerts(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

function upsertAlert(a) {
  const i = alerts.findIndex((x) => x.id === a.id);
  if (i >= 0) alerts[i] = a; else alerts.unshift(a);
  alerts.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  if (!seenAlerts.has(a.id)) { seenAlerts.add(a.id); if (a.status === "open") notifyDesktop(a); }
}

async function loadAlerts({ initial = false } = {}) {
  if (!key()) { alerts = []; renderAlerts(); return; }
  const r = await api("/api/key/alerts");
  if (!r.ok) return;
  alertThreshold = r.data.threshold ?? alertThreshold;
  if (initial) r.data.alerts.forEach((a) => seenAlerts.add(a.id)); // don't re-notify alerts from before this page opened
  const fresh = r.data.alerts.filter((a) => !seenAlerts.has(a.id));
  alerts = r.data.alerts;
  fresh.forEach(upsertAlert);
  renderAlerts();
}

function onStreamEvent(chunk) {
  let event = "message", data = "";
  for (const line of chunk.split("\n")) { if (line.startsWith("event:")) event = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
  if (!data) return;
  const d = JSON.parse(data);
  if (event === "hello") { alertThreshold = d.threshold ?? alertThreshold; return loadAlerts(); }
  if (event === "alert") { const isNew = !alerts.some((x) => x.id === d.alert.id); upsertAlert(d.alert); renderAlerts(); if (isNew) refresh(); return; }
  if (event === "alerts") return loadAlerts();
  if (event === "reset") { alerts = []; seenAlerts.clear(); renderAlerts(); }
}

async function connectStream() {
  if (streamCtl) streamCtl.abort();
  if (!key()) return;
  const ctl = new AbortController(); streamCtl = ctl;
  try {
    const r = await fetch("/api/key/alerts/stream", { headers: { "X-Keyring-Key": key() }, signal: ctl.signal });
    if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
    streamLive = true;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); try { await onStreamEvent(c); } catch {} }
    }
  } catch { /* fall through to polling + reconnect */ }
  streamLive = false;
  if (streamCtl === ctl && !ctl.signal.aborted) setTimeout(() => { if (streamCtl === ctl) connectStream(); }, 3000);
}
// Fallback: poll while the live stream is down.
setInterval(() => { if (!streamLive && key()) loadAlerts(); }, 5000);

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button,[data-charge-id],[data-close]");
  if (!t) return;
  if (t.matches("[data-close]")) { $("#drawer").hidden = true; $("#modal").hidden = true; return; }
  if (t.id === "bell" || t.matches("[data-open-alerts]")) return openAlerts();
  if (t.id === "enableNotif") { if ("Notification" in window) await Notification.requestPermission(); return renderBell(); }
  if (t.dataset.hideBanner) { hideBanner(t.dataset.hideBanner); return renderBanner(); }
  if (t.dataset.dismiss) {
    const r = await api(`/api/key/alerts/${t.dataset.dismiss}/dismiss`, { method: "POST" });
    if (r.ok) { upsertAlert(r.data.alert); renderAlerts(); toast(`Marked as you: ${esc(r.data.alert.merchantName)} ${money(r.data.alert.amount)}. Your card was not changed.`, "ok"); }
    else toast(esc(r.data.error), "err");
    return;
  }
  if (t.id === "createKey") {
    const r = await api("/api/keyring", { method: "POST" });
    if (!r.ok) return toast(esc(r.data.error), "err");
    localStorage.setItem("keyring.key", r.data.key); localStorage.setItem("keyring.handle", r.data.handle);
    toast(`Key created. Handle <code>${esc(r.data.handle)}</code>. The secret is stored only in this browser.`, "ok");
    await loadStatus(); await refresh(); await loadAlerts({ initial: true }); connectStream(); return;
  }
  if (t.id === "reset") { if (!confirm("Reset the demo? This deletes the demo's sandbox vault tokens and local data.")) return; await api("/api/demo/reset", { method: "POST" }); localStorage.clear(); sessionStorage.removeItem("keyring.hiddenBanners"); if (streamCtl) streamCtl.abort(); streamCtl = null; alerts = []; seenAlerts.clear(); $("#drawer").hidden = true; $("#toast").hidden = true; await loadStatus(); await refresh(); renderAlerts(); return; }
  if (t.id === "verify") { t.disabled = true; const r = await api("/api/key/verify", { method: "POST" }); t.disabled = false; toast(r.ok ? "Checked each merchant's PayPal vault." : esc(r.data.error), r.ok ? "ok" : "err"); return refresh(); }
  if (t.dataset.save) {
    t.disabled = true; t.textContent = "Saving with PayPal vault…";
    const r = await api(`/api/merchants/${t.dataset.save}/save-card`, { method: "POST", body: { handle: handle() } });
    renderMerchants();
    if (!r.ok) toast(esc(r.data.error), "err");
    else toast(r.data.reused ? "This merchant already has an active saved card." : `Saved ${esc(r.data.card.brand)} •••• ${esc(r.data.card.last4)} at ${esc(t.closest(".merchant").querySelector("b").textContent)}. ${r.data.card.source === "paypal_vault" ? `PayPal vault token <span class="mono">${esc(r.data.card.paymentTokenId)}</span>` : `<b>Simulated</b>: ${esc(r.data.card.simulatedReason)}`}`, "ok");
    return refresh();
  }
  if (t.dataset.charge) {
    const m = status.merchants.find((x) => x.id === t.dataset.charge); const p = m.presets[Number(t.dataset.i)];
    t.disabled = true;
    const r = await api(`/api/merchants/${m.id}/charge`, { method: "POST", body: { amount: p.amount, description: p.label } });
    t.disabled = false;
    const c = r.data.charge;
    if (!c) toast(esc(r.data.error), "err");
    else if (c.status === "blocked") toast(`⛔ ${esc(c.blockedReason)}`, "err");
    else toast(`${esc(m.name)} charged ${money(c.amount)}: ${esc(c.status)}${c.orderId ? ` · PayPal order <span class="mono">${esc(c.orderId)}</span>` : ""}. Recognizer: <b>${esc(c.recognition.headline)}</b>${r.data.alertId ? " · ⚠ Keyring raised an alert" : ""}`, c.status === "completed" ? "ok" : "err");
    return refresh();
  }
  if (t.dataset.q) { $("#askInput").value = t.dataset.q; return ask($("#askForm").dataset.charge, t.dataset.q); }
  if (t.dataset.lock) return lockCard(t.dataset.lock, t.dataset.locked === "true");
  if (t.dataset.revoke) return revokeCard(t.dataset.revoke);
  if (t.dataset.chargeId) return openCharge(t.dataset.chargeId);
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "askForm") return;
  e.preventDefault();
  ask(e.target.dataset.charge, $("#askInput").value);
});

await loadStatus();
await refresh();
await loadAlerts({ initial: true });
connectStream();

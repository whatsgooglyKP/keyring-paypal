import { buildFeatures, predict, type Contribution } from "./model.js";
import { merchantById } from "./merchants.js";
import type { Card, Charge } from "./store.js";

export type Verdict = "LOOKS_LIKE_YOU" | "NOT_SURE" | "DOESNT_LOOK_LIKE_YOU";
export interface Recognition {
  looksLikeYou: number; pNotYou: number; verdict: Verdict; headline: string;
  facts: string[]; suggestion: string; topReasons: { label: string; impact: number; direction: "you" | "not_you" }[];
  features: Record<string, number>; contributions: Contribution[];
  explainer: "template"; model: "logistic_regression (synthetic training data)";
}

const DAY = 86400_000;
/** How to describe a feature that is OFF (0), so "absence" reasons read correctly. */
const OFF_LABEL: Record<string, string> = {
  recurring_fit: "Doesn't match your subscription's amount and billing cycle",
  off_cycle_sub: "Not an off-cycle subscription charge",
  dormant: "Card used at this merchant recently",
  first_charge: "You've paid this merchant before",
  night: "Daytime charge",
  velocity_24h: "No burst of charges in the last 24h",
  micro_amount: "Not a tiny test charge",
};
const TZ = "America/New_York";
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
const money = (n: number) => `$${n.toFixed(2)}`;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ago = (days: number) => days < 1 ? "earlier today" : days < 45 ? `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago` : days < 540 ? `${Math.round(days / 30)} months ago` : `${(days / 365).toFixed(1)} years ago`;

/** Explain a charge on a saved card, scoring it against that card's history at that merchant. */
export function recognize(charge: Pick<Charge, "id" | "amount" | "at" | "merchantId" | "cardId">, card: Card, allCharges: Charge[]): Recognition {
  const m = merchantById(charge.merchantId)!;
  const t = new Date(charge.at).getTime();
  const prior = allCharges
    .filter((c) => c.id !== charge.id && c.cardId === card.id && c.status === "completed" && new Date(c.at).getTime() < t)
    .sort((a, b) => a.at.localeCompare(b.at));
  const last = prior[prior.length - 1];
  const daysSinceLast = last ? (t - new Date(last.at).getTime()) / DAY : 1000;
  const sub = m.subscription;
  const subActive = !!sub && !card.revokedAt;
  const usual = median(prior.map((c) => c.amount)) || sub?.amount || 25;
  const velocity24h = prior.filter((c) => t - new Date(c.at).getTime() <= DAY).length;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(new Date(charge.at))) % 24;

  const features = buildFeatures({
    amount: charge.amount, usualAmount: usual, hasSub: subActive, subAmount: sub?.amount ?? 0, daysSinceLast,
    intervalDays: sub?.intervalDays ?? 0, firstCharge: prior.length === 0, night: hour < 6, velocity24h,
  });
  const { pNotYou, contributions } = predict(features);
  const looksLikeYou = Math.min(0.99, Math.max(0.01, 1 - pNotYou)); // never claim certainty
  const verdict: Verdict = looksLikeYou >= 0.7 ? "LOOKS_LIKE_YOU" : looksLikeYou >= 0.4 ? "NOT_SURE" : "DOESNT_LOOK_LIKE_YOU";

  const savedDays = (t - new Date(card.storySavedAt).getTime()) / DAY;
  const facts: string[] = [];
  facts.push(`${money(charge.amount)} from ${m.name} (${m.category}) on your ${card.brand} •••• ${card.last4}.`);
  facts.push(`You saved this card at ${m.name} on ${fmtDate(card.storySavedAt)}, ${ago(savedDays)}.`);
  if (sub) {
    if (features.recurring_fit) facts.push(`You have an active ${sub.plan} plan at ${money(sub.amount)} every ${sub.intervalDays} days. The last renewal was ${fmtDate(last!.at)}, ${Math.round(daysSinceLast)} days before this. This charge fits that cycle.`);
    else if (subActive) facts.push(`You have an active ${sub.plan} plan at ${money(sub.amount)} every ${sub.intervalDays} days, but this charge does not fit it: ${Math.abs(charge.amount - sub.amount) > 0.1 * sub.amount ? `it's ${(charge.amount / sub.amount).toFixed(1)}x the plan price` : "right amount"}${last ? `, ${Math.round(daysSinceLast)} day(s) after the last charge` : ""}.`);
  } else facts.push(m.history.note ?? `No subscription at ${m.name}; these are one-off purchases.`);
  if (prior.length) facts.push(`Your usual charge here is ${money(usual)} across ${prior.length} past charge${prior.length === 1 ? "" : "s"}; this one is ${(charge.amount / usual).toFixed(1)}x that.`);
  else facts.push(`This is the first charge ever from ${m.name} on this card.`);
  if (features.dormant && last) facts.push(`${m.name} hadn't charged this card in ${Math.round(daysSinceLast)} days (last: ${fmtDate(last.at)}). A sudden charge on a card you forgot about is a common sign of an unwanted reactivation or a breached merchant.`);
  if (features.micro_amount) facts.push(`Tiny amounts like ${money(charge.amount)} are often used to test whether a stolen card works.`);
  if (velocity24h >= 2) facts.push(`${velocity24h} other charges from ${m.name} in the 24 hours before this one.`);
  if (hour < 6) facts.push(`It happened at ${hour}:00 your time (ET).`);

  const pct = Math.round(looksLikeYou * 100);
  const headline = verdict === "LOOKS_LIKE_YOU" ? `Looks like you (${pct}%)` : verdict === "NOT_SURE" ? `Not sure (${pct}% looks like you)` : `Doesn't look like you (${pct}% looks like you)`;
  const suggestion = verdict === "LOOKS_LIKE_YOU"
    ? "This matches how you normally pay this merchant. No action needed."
    : `If you don't recognize it, lock this card at ${m.name} now (it's reversible), then revoke it if you no longer use ${m.name}. To get money back, dispute the charge with your card issuer or through PayPal.`;
  const topReasons = contributions.filter((c) => Math.abs(c.impact) > 0.15).slice(0, 4)
    .map((c) => ({ label: c.value === 0 && OFF_LABEL[c.feature] ? OFF_LABEL[c.feature] : c.label, impact: Math.round(c.impact * 100) / 100, direction: (c.impact > 0 ? "not_you" : "you") as "you" | "not_you" }));

  return { looksLikeYou, pNotYou, verdict, headline, facts, suggestion, topReasons, features, contributions,
    explainer: "template", model: "logistic_regression (synthetic training data)" };
}

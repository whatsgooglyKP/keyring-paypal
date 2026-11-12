/**
 * Smart checkout at Maison Vale Boutique: a $2,450 designer dress the cardholder
 * has confirmed is legitimate. Every benefit number is computed from the example
 * reward and fee rules below — never hardcoded in the UI.
 *
 * Product names and reward terms are fictional sandbox-demo terms, not real
 * issuer terms. The UI must show: "Example reward terms (sandbox demo), not real card terms."
 */
import { MAISON_VALE } from "./merchants.js";

export const DOLLARS = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => {
  const [d, c] = DOLLARS(n).toFixed(2).split(".");
  return `$${d.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${c}`;
};
const commas = (n: number) => Math.round(n).toLocaleString("en-US");

export const PURCHASE = {
  merchantId: MAISON_VALE.id,
  merchantName: MAISON_VALE.name,
  merchantCategory: MAISON_VALE.category,
  emoji: MAISON_VALE.emoji,
  productName: "Atelier silk midi dress",
  amount: 2450,
  currency: "USD" as const,
  buttonLabel: "Shop: designer dress ($2,450)",
  disclaimer: "Example reward terms (sandbox demo), not real card terms.",
};

export interface TransferFeeRule { rate: number; fixed: number }

export type RewardRule =
  | { kind: "miles"; milesPerDollar: number; promoMiles: number; promoLabel: string; mileValueUsd: number }
  | { kind: "cashback"; rate: number; promoFixed: number; promoLabel: string }
  | { kind: "none" };

export interface PaymentOptionDef {
  id: "travel" | "cashback" | "ach";
  kind: "travel_card" | "cashback_card" | "bank_transfer";
  productName: string;
  brand: string;
  last4: string;
  testCard?: { number: string; expiry: string; name: string };
  simulated: boolean;
  simulatedReason?: string;
  rewards: RewardRule;
  fee: TransferFeeRule;
}

/** Fictional card products (not real issuers) and an ACH checking account. */
export const PAYMENT_OPTIONS: PaymentOptionDef[] = [
  {
    id: "travel",
    kind: "travel_card",
    productName: "Northstar Voyager Visa",
    brand: "VISA",
    last4: "1111",
    testCard: { number: "4111111111111111", expiry: "2030-12", name: "Demo Customer" },
    simulated: false,
    rewards: {
      kind: "miles",
      milesPerDollar: 4,
      promoMiles: 200,
      promoLabel: "Atelier travel promo bonus",
      mileValueUsd: 0.015,
    },
    // Example demo processing fee (not a real network schedule).
    fee: { rate: 0.029, fixed: 0.30 },
  },
  {
    id: "cashback",
    kind: "cashback_card",
    productName: "Cedar Ledger Mastercard",
    brand: "MASTERCARD",
    last4: "4444",
    testCard: { number: "5555555555554444", expiry: "2030-11", name: "Demo Customer" },
    simulated: false,
    rewards: {
      kind: "cashback",
      rate: 0.05,
      promoFixed: 377.50,
      promoLabel: "limited-time Atelier cash-back promo",
    },
    fee: { rate: 0.029, fixed: 0.30 },
  },
  {
    id: "ach",
    kind: "bank_transfer",
    productName: "Harbor Checking",
    brand: "ACH",
    last4: "2187",
    simulated: true,
    simulatedReason: "Bank transfer (ACH) is simulated in this demo. PayPal sandbox has no ACH vault path here.",
    rewards: { kind: "none" },
    fee: { rate: 0, fixed: 0 },
  },
];

/** Named routes for the compact "cheapest transfer" comparison (card/bank → card/bank). */
export const TRANSFER_ROUTES: { id: string; label: string; fee: TransferFeeRule }[] = [
  { id: "card_to_card", label: "Card to card (network push)", fee: { rate: 0.03, fixed: 0 } },
  { id: "card_to_merchant", label: "Card to merchant (card network)", fee: { rate: 0.029, fixed: 0.30 } },
  { id: "bank_to_card", label: "Bank to card (instant debit)", fee: { rate: 0.015, fixed: 0 } },
  { id: "bank_to_merchant", label: "Bank to merchant (ACH)", fee: { rate: 0, fixed: 0 } },
];

export function feeFor(amount: number, rule: TransferFeeRule): number {
  return DOLLARS(amount * rule.rate + rule.fixed);
}

export function feeMath(amount: number, rule: TransferFeeRule): string {
  if (rule.rate === 0 && rule.fixed === 0) return `${money(0)} fee`;
  const pctPart = DOLLARS(amount * rule.rate);
  const fee = feeFor(amount, rule);
  const pct = DOLLARS(rule.rate * 100);
  const pctLabel = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  if (rule.fixed) return `${pctLabel}% × ${money(amount)} = ${money(pctPart)} + ${money(rule.fixed)} = ${money(fee)}`;
  return `${pctLabel}% × ${money(amount)} = ${money(fee)}`;
}

export interface OptionBenefits {
  headline: string;
  math: string;
  fee: number;
  feeLabel: string;
  feeMath: string;
  dollarBenefit: number;
  miles?: number;
  baseMiles?: number;
  promoMiles?: number;
  estValue?: number;
  mileValueUsd?: number;
  cashBack?: number;
  baseCashBack?: number;
  promoFixed?: number;
  savedVsCard?: number;
}

export function benefitsFor(amount: number, opt: PaymentOptionDef, cardFee: number): OptionBenefits {
  const fee = feeFor(amount, opt.fee);
  const feeM = feeMath(amount, opt.fee);
  const feeLabel = fee === 0 ? `${money(0)} fee` : `${money(fee)} (${feeM})`;
  const r = opt.rewards;
  if (r.kind === "miles") {
    const baseMiles = Math.round(amount * r.milesPerDollar);
    const miles = baseMiles + r.promoMiles;
    const estValue = DOLLARS(miles * r.mileValueUsd);
    const cents = DOLLARS(r.mileValueUsd * 100);
    return {
      headline: `≈ ${commas(miles)} airline miles (~${money(estValue)} est. value)`,
      math: `${r.milesPerDollar}× miles × ${money(amount)} = ${commas(baseMiles)} miles + ${commas(r.promoMiles)} ${r.promoLabel} = ${commas(miles)} miles × $${r.mileValueUsd} est. per mile (${cents} cents) = ${money(estValue)}`,
      fee, feeLabel, feeMath: feeM, dollarBenefit: estValue,
      miles, baseMiles, promoMiles: r.promoMiles, estValue, mileValueUsd: r.mileValueUsd,
    };
  }
  if (r.kind === "cashback") {
    const baseCashBack = DOLLARS(amount * r.rate);
    const cashBack = DOLLARS(baseCashBack + r.promoFixed);
    const pct = DOLLARS(r.rate * 100);
    return {
      headline: `${money(cashBack)} cash back`,
      math: `${pct}% × ${money(amount)} = ${money(baseCashBack)} + ${money(r.promoFixed)} ${r.promoLabel} = ${money(cashBack)} cash back`,
      fee, feeLabel, feeMath: feeM, dollarBenefit: cashBack,
      cashBack, baseCashBack, promoFixed: r.promoFixed,
    };
  }
  const savedVsCard = DOLLARS(cardFee - fee);
  return {
    headline: `Bank transfer: ${money(fee)} fee, the lowest-cost way to move the money`,
    math: `ACH fee ${money(fee)}. Saves ${money(savedVsCard)} vs paying by card (${money(cardFee)} card-network fee).`,
    fee, feeLabel, feeMath: feeM, dollarBenefit: savedVsCard, savedVsCard,
  };
}

export interface ComputedOption {
  id: PaymentOptionDef["id"];
  kind: PaymentOptionDef["kind"];
  productName: string;
  brand: string;
  last4: string;
  simulated: boolean;
  simulatedReason?: string;
  benefits: OptionBenefits;
}

export function buildTransferComparison(amount: number) {
  const routes = TRANSFER_ROUTES.map((r) => ({
    id: r.id,
    label: r.label,
    fee: feeFor(amount, r.fee),
    math: feeMath(amount, r.fee),
    cheapest: false,
  }));
  const min = Math.min(...routes.map((r) => r.fee));
  for (const r of routes) r.cheapest = r.fee === min;
  const cheapest = routes.find((r) => r.cheapest)!;
  const cardRoute = routes.find((r) => r.id === "card_to_merchant")!;
  const savedVsCard = DOLLARS(cardRoute.fee - cheapest.fee);
  const maxFee = Math.max(...routes.map((r) => r.fee));
  const savedVsMostExpensive = DOLLARS(maxFee - cheapest.fee);
  return {
    routes,
    cheapestId: cheapest.id,
    cheapestFee: cheapest.fee,
    savedVsCard,
    savedVsMostExpensive,
    summary: `Bank transfer: ${money(cheapest.fee)} fee, the lowest-cost way to move the money. Saves ${money(savedVsCard)} vs paying by card (${money(cardRoute.fee)} fee).`,
  };
}

export function buildSmartCheckout(amount = PURCHASE.amount) {
  const transfer = buildTransferComparison(amount);
  const cardFee = transfer.routes.find((r) => r.id === "card_to_merchant")!.fee;
  const options: ComputedOption[] = PAYMENT_OPTIONS.map((opt) => ({
    id: opt.id,
    kind: opt.kind,
    productName: opt.productName,
    brand: opt.brand,
    last4: opt.last4,
    simulated: opt.simulated,
    simulatedReason: opt.simulatedReason,
    benefits: benefitsFor(amount, opt, cardFee),
  }));
  const best = options.reduce((a, b) => (a.benefits.dollarBenefit >= b.benefits.dollarBenefit ? a : b));
  const travel = options.find((o) => o.id === "travel")!;
  const cash = options.find((o) => o.id === "cashback")!;
  const ach = options.find((o) => o.id === "ach")!;
  const templateRecommendation =
    `${cash.productName} yields ${money(cash.benefits.cashBack!)} cash back on this ${money(amount)} purchase — more dollar value than ${travel.benefits.headline} on ${travel.productName}, or the ${money(ach.benefits.savedVsCard!)} you save with a ${money(ach.benefits.fee)}-fee ${ach.productName} transfer.`;
  return {
    purchase: { ...PURCHASE, amount, confirmedLegitimate: true },
    options,
    transfer,
    bestOptionId: best.id,
    templateRecommendation,
    disclaimer: PURCHASE.disclaimer,
  };
}

export type SmartCheckoutQuote = ReturnType<typeof buildSmartCheckout>;

export const optionDef = (id: string) => PAYMENT_OPTIONS.find((o) => o.id === id);

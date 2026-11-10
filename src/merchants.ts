/**
 * Demo merchants. In production each would be a separate Braintree/PayPal
 * merchant with its own vault. In this prototype all three share ONE sandbox
 * REST app, and each gets its own vault customer id, which mirrors the real
 * per-merchant shape: a token saved at one merchant is invisible to the others.
 */
export interface Merchant {
  id: string; name: string; category: string; emoji: string;
  testCard: { number: string; expiry: string; name: string };
  subscription?: { plan: string; amount: number; intervalDays: number };
  /** Synthetic history (labeled as such) so the recognizer has a baseline. */
  history: { monthsAgoSaved: number; pattern: "monthly" | "coffee" | "dormant"; note?: string };
  presets: { label: string; amount: number; hint: string }[];
}

// PayPal sandbox test card numbers (developer.paypal.com/tools/sandbox/card-testing).
export const MERCHANTS: Merchant[] = [
  {
    id: "streamco", name: "StreamCo+", category: "Streaming subscription", emoji: "📺",
    testCard: { number: "4111111111111111", expiry: "2030-12", name: "Demo Customer" },
    subscription: { plan: "Premium monthly", amount: 15.49, intervalDays: 30 },
    history: { monthsAgoSaved: 7, pattern: "monthly" },
    presets: [
      { label: "Monthly renewal $15.49", amount: 15.49, hint: "on cycle" },
      { label: "Surprise $89.99 'annual upgrade'", amount: 89.99, hint: "off cycle" },
    ],
  },
  {
    id: "beanbrew", name: "Bean & Brew Coffee", category: "Coffee shop", emoji: "☕",
    testCard: { number: "5555555555554444", expiry: "2030-11", name: "Demo Customer" },
    history: { monthsAgoSaved: 3, pattern: "coffee" },
    presets: [
      { label: "Latte $6.25", amount: 6.25, hint: "usual" },
      { label: "$1.00 test charge", amount: 1.0, hint: "card test" },
    ],
  },
  {
    id: "ironworks", name: "IronWorks Gym", category: "Gym membership you quit", emoji: "🏋️",
    testCard: { number: "378282246310005", expiry: "2029-06", name: "Demo Customer" },
    history: { monthsAgoSaved: 26, pattern: "dormant", note: "Your old membership here billed $39.00 a month, then stopped. You may have forgotten this card is still saved." },
    presets: [{ label: "$249.00 'reactivation fee'", amount: 249.0, hint: "dormant 14 months" }],
  },
];

export const merchantById = (id: string) => MERCHANTS.find((m) => m.id === id);

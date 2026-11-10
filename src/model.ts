import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR } from "./paths.js";

interface Artifact { type: string; features: string[]; labels: Record<string, string>; mean: number[]; scale: number[]; coef: number[]; intercept: number }
export interface Contribution { feature: string; label: string; value: number; impact: number }

const artifact: Artifact = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "keyring_model.json"), "utf8"));
export const metrics: Record<string, unknown> = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "metrics.json"), "utf8")); } catch { return {}; }
})();

export interface RawSignals {
  amount: number; usualAmount: number; hasSub: boolean; subAmount: number; daysSinceLast: number;
  intervalDays: number; firstCharge: boolean; night: boolean; velocity24h: number;
}

/** Must match row() in scripts/train_model.py exactly. */
export function buildFeatures(s: RawSignals): Record<string, number> {
  const fit = s.hasSub && Math.abs(s.daysSinceLast - s.intervalDays) <= 3 && Math.abs(s.amount - s.subAmount) <= 0.1 * s.subAmount;
  return {
    log_amount: Math.log1p(s.amount),
    log_amount_ratio: Math.log((s.amount + 1) / (s.usualAmount + 1)),
    recurring_fit: fit ? 1 : 0,
    off_cycle_sub: s.hasSub && !fit ? 1 : 0,
    log_days_since_last: Math.log1p(Math.min(s.daysSinceLast, 1000)),
    dormant: s.daysSinceLast > 180 ? 1 : 0,
    first_charge: s.firstCharge ? 1 : 0,
    night: s.night ? 1 : 0,
    velocity_24h: Math.min(s.velocity24h, 10),
    micro_amount: s.amount < 2 ? 1 : 0,
  };
}

/** Returns P(not the cardholder) and per-feature contributions (positive = pushes toward "not you"). */
export function predict(features: Record<string, number>): { pNotYou: number; contributions: Contribution[] } {
  let z = artifact.intercept;
  const contributions = artifact.features.map((f, i) => {
    const impact = artifact.coef[i] * ((features[f] - artifact.mean[i]) / artifact.scale[i]);
    z += impact;
    return { feature: f, label: artifact.labels[f] ?? f, value: features[f], impact };
  });
  contributions.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return { pNotYou: 1 / (1 + Math.exp(-z)), contributions };
}

export const modelInfo = { type: artifact.type, features: artifact.features, trainedOn: "synthetic" };

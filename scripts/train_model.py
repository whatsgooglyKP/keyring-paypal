#!/usr/bin/env python3
"""
Train Keyring's charge recognizer on a SYNTHETIC labeled dataset.

Adapted from Locus (scripts/train_model.py): same standardized logistic
regression, new features about a charge on a SAVED CARD at a merchant.
Label 1 = "not the cardholder" (unauthorized / unrecognized). The app shows
"looks like you" = 1 - P(not you).

Outputs (read by the Node app at runtime; Python is only needed to retrain):
  model/keyring_model.json   standardized logistic-regression weights
  model/metrics.json         held-out evaluation on synthetic data

Reproducible: fixed seed.   python3 scripts/train_model.py
Feature order and definitions MUST match src/model.ts (buildFeatures).
"""
import json, math, os, datetime
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, precision_score, recall_score, confusion_matrix, average_precision_score

SEED = 11
rng = np.random.default_rng(SEED)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FEATURES = [
    ("log_amount", "Amount (log)"),
    ("log_amount_ratio", "Amount vs. your usual at this merchant"),
    ("recurring_fit", "Matches your subscription's amount and billing cycle"),
    ("off_cycle_sub", "Subscription merchant charging off-cycle or a different amount"),
    ("log_days_since_last", "Days since this merchant last charged you"),
    ("dormant", "Card dormant at this merchant 180+ days"),
    ("first_charge", "First charge ever from this merchant"),
    ("night", "Late-night charge (00:00-05:59 your time)"),
    ("velocity_24h", "Charges from this merchant in the last 24h"),
    ("micro_amount", "Tiny test-sized charge (under $2)"),
]

def row(amount, usual, has_sub, sub_amount, days_since, interval, first, night, velocity):
    if has_sub:
        fit = abs(days_since - interval) <= 3 and abs(amount - sub_amount) <= 0.1 * sub_amount
    else:
        fit = False
    return [
        math.log1p(amount),
        math.log((amount + 1.0) / (usual + 1.0)),
        1.0 if fit else 0.0,
        1.0 if (has_sub and not fit) else 0.0,
        math.log1p(min(days_since, 1000)),
        1.0 if days_since > 180 else 0.0,
        1.0 if first else 0.0,
        float(night),
        float(min(velocity, 10)),
        1.0 if amount < 2 else 0.0,
    ]

def legit(n):
    out = []
    for _ in range(n):
        k = rng.random()
        if k < 0.40:   # subscription renewal on cycle (sometimes a price change or retry)
            sub = rng.choice([6.99, 9.99, 12.99, 15.49, 22.99, 49.0])
            interval = rng.choice([30, 30, 30, 7, 365])
            days = interval + rng.integers(-2, 3)
            amt = sub if rng.random() < 0.9 else sub * rng.uniform(1.05, 1.3)
            out.append(row(amt, sub, True, sub, days, interval, False, rng.random() < 0.3, 0))
        elif k < 0.85: # everyday merchant (coffee, groceries)
            usual = rng.lognormal(math.log(14), 0.6)
            amt = rng.lognormal(math.log(usual), 0.45)
            days = rng.exponential(5)
            out.append(row(amt, usual, False, 0, days, 0, False, rng.random() < 0.03, rng.poisson(0.4)))
        else:          # legit first purchase or a returning old merchant
            usual = rng.lognormal(math.log(40), 0.6)
            amt = rng.lognormal(math.log(usual), 0.7)
            first = rng.random() < 0.6
            days = 1000 if first else rng.uniform(30, 600)
            out.append(row(amt, usual, False, 0, days, 0, first, rng.random() < 0.05, 0))
    return out

def fraud(n):
    out = []
    for _ in range(n):
        k = rng.random()
        if k < 0.30:   # forgotten / dormant card suddenly charged (breach at old merchant)
            usual = rng.lognormal(math.log(30), 0.5)
            amt = usual * rng.uniform(1.5, 20)
            days = rng.uniform(181, 1000)
            out.append(row(amt, usual, rng.random() < 0.4, usual, days, 30, False, rng.random() < 0.4, rng.poisson(0.8)))
        elif k < 0.55: # subscription merchant off-cycle upsell / unauthorized plan change
            sub = rng.choice([6.99, 9.99, 12.99, 15.49, 22.99])
            amt = sub * rng.uniform(2.5, 12)
            days = rng.uniform(0, 25)
            out.append(row(amt, sub, True, sub, days, 30, False, rng.random() < 0.35, rng.poisson(0.5)))
        elif k < 0.75: # card testing on a stolen token
            usual = rng.lognormal(math.log(14), 0.6)
            amt = rng.uniform(0.5, 2.5)
            out.append(row(amt, usual, False, 0, rng.exponential(3), 0, rng.random() < 0.5, rng.random() < 0.5, rng.integers(2, 9)))
        else:          # big spend at an everyday merchant (account takeover)
            usual = rng.lognormal(math.log(14), 0.6)
            amt = usual * rng.uniform(4, 40)
            out.append(row(amt, usual, False, 0, rng.exponential(6), 0, rng.random() < 0.3, rng.random() < 0.45, rng.poisson(1.2)))
    return out

N, BAD_RATE = 20000, 0.08
nb = int(N * BAD_RATE)
X = np.array(legit(N - nb) + fraud(nb))
y = np.array([0] * (N - nb) + [1] * nb)

Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=SEED, stratify=y)
scaler = StandardScaler().fit(Xtr)
clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=1.0).fit(scaler.transform(Xtr), ytr)

p = clf.predict_proba(scaler.transform(Xte))[:, 1]
pred = (p >= 0.5).astype(int)
tn, fp, fn, tp = confusion_matrix(yte, pred).ravel()
metrics = {
    "note": "All numbers are from a held-out split of SYNTHETIC data generated by scripts/train_model.py. They are not real-world performance.",
    "dataset": {"rows": int(N), "unauthorized_rate": BAD_RATE, "test_rows": int(len(yte)), "seed": SEED, "synthetic": True},
    "model": "LogisticRegression (class_weight=balanced) on standardized features; label 1 = not the cardholder",
    "roc_auc": round(float(roc_auc_score(yte, p)), 4),
    "average_precision": round(float(average_precision_score(yte, p)), 4),
    "threshold": 0.5,
    "precision_at_0_5": round(float(precision_score(yte, pred)), 4),
    "recall_at_0_5": round(float(recall_score(yte, pred)), 4),
    "confusion_at_0_5": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
artifact = {
    "type": "logistic_regression_standardized",
    "version": 1,
    "features": [f for f, _ in FEATURES],
    "labels": {f: l for f, l in FEATURES},
    "mean": [float(v) for v in scaler.mean_],
    "scale": [float(v) for v in scaler.scale_],
    "coef": [float(v) for v in clf.coef_[0]],
    "intercept": float(clf.intercept_[0]),
    "trained_on": "synthetic",
    "metrics_file": "model/metrics.json",
}
os.makedirs(os.path.join(ROOT, "model"), exist_ok=True)
with open(os.path.join(ROOT, "model", "keyring_model.json"), "w") as f:
    json.dump(artifact, f, indent=2)
with open(os.path.join(ROOT, "model", "metrics.json"), "w") as f:
    json.dump(metrics, f, indent=2)
print(json.dumps({k: metrics[k] for k in ("roc_auc", "average_precision", "precision_at_0_5", "recall_at_0_5")}, indent=2))
print("coefficients:", {f: round(float(c), 3) for (f, _), c in zip(FEATURES, clf.coef_[0])})

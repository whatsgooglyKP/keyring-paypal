import path from "node:path";
import { fileURLToPath } from "node:url";
// src/ (tsx) and dist/ (compiled) both sit one level below the repo root.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const MODEL_DIR = path.join(ROOT, "model");
export const PUBLIC_DIR = path.join(ROOT, "public");

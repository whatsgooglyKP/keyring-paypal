/**
 * Minimal Google Gemini client (generativelanguage v1beta REST).
 * The key comes from process.env.GEMINI_API_KEY only; it is sent as a header and never logged or returned.
 * Resilience: ~8 s timeout per call, one retry on 429/503 (and 500/timeout), then the next model in the chain.
 * Callers fall back to the deterministic template if every model fails.
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
export const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 8000;
const TOTAL_BUDGET_MS = Number(process.env.GEMINI_TOTAL_BUDGET_MS) || 22000;

export const geminiConfigured = () => !!process.env.GEMINI_API_KEY && process.env.GEMINI_DISABLED !== "1";
export const modelChain = () => [PRIMARY_MODEL, FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);

export interface Attempt { model: string; ok: boolean; httpStatus?: number; ms: number; error?: string }
export interface GeminiResult<T> { ok: boolean; data?: T; model?: string; attempts: Attempt[] }

const RETRYABLE = new Set([429, 500, 503, 504]);

/** Ask for JSON matching `schema`. `validate` may reject an answer (e.g. ungrounded) so the next model is tried. */
export async function generateJson<T>(opts: { system: string; user: string; schema: object; temperature?: number; validate?: (d: T) => string | null }): Promise<GeminiResult<T>> {
  const attempts: Attempt[] = [];
  if (!geminiConfigured()) return { ok: false, attempts: [{ model: "-", ok: false, ms: 0, error: "GEMINI_API_KEY not set" }] };
  const started = Date.now();
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: opts.schema, temperature: opts.temperature ?? 0.2, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } },
  });
  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = TOTAL_BUDGET_MS - (Date.now() - started);
      if (budget < 1500) { attempts.push({ model, ok: false, ms: 0, error: "time budget exhausted" }); return { ok: false, attempts }; }
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(TIMEOUT_MS, budget));
      let status: number | undefined;
      try {
        const r = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
          body,
        });
        status = r.status;
        const d: any = await r.json().catch(() => ({}));
        if (!r.ok) {
          attempts.push({ model, ok: false, httpStatus: status, ms: Date.now() - t0, error: String(d?.error?.message || r.statusText).slice(0, 160) });
          if (RETRYABLE.has(status) && attempt === 0) { await new Promise((res) => setTimeout(res, 600)); continue; }
          break; // next model
        }
        const text = (d?.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought && typeof p.text === "string").map((p: any) => p.text).join("");
        let parsed: T;
        try { parsed = JSON.parse(text); } catch { attempts.push({ model, ok: false, httpStatus: status, ms: Date.now() - t0, error: `unparseable JSON (finishReason ${d?.candidates?.[0]?.finishReason})` }); break; }
        const bad = opts.validate?.(parsed);
        if (bad) { attempts.push({ model, ok: false, httpStatus: status, ms: Date.now() - t0, error: `rejected: ${bad}` }); break; }
        attempts.push({ model, ok: true, httpStatus: status, ms: Date.now() - t0 });
        return { ok: true, data: parsed, model, attempts };
      } catch (e: any) {
        const timedOut = e?.name === "AbortError";
        attempts.push({ model, ok: false, httpStatus: status, ms: Date.now() - t0, error: timedOut ? `timeout after ${Date.now() - t0} ms` : String(e?.message || e).slice(0, 160) });
        if (attempt === 0 && !timedOut) { await new Promise((res) => setTimeout(res, 600)); continue; }
        break;
      } finally { clearTimeout(timer); }
    }
  }
  return { ok: false, attempts };
}

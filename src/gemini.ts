import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { EXTRACTION_SCHEMA, coerceExtraction, type Extraction } from './schema.js';

export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';

/**
 * Minimum gap between Gemini calls, process-wide.
 *
 * Free tiers cap requests per minute (~15 RPM on the lite models), so 6.5s
 * between call starts keeps us at ~9 RPM — comfortably under, with headroom for
 * the retry traffic that a burst would otherwise cause.
 */
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 6500);
const MAX_TRANSIENT_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 5);

let _ai: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing. Copy .env.example to .env and fill it in.');
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialises call *starts* across the whole process.
 *
 * Concurrency in runAll is about scrape/search throughput; the model is the
 * scarce resource, so every caller queues behind this regardless of how many
 * apps are in flight. Cheaper than discovering the rate limit by being denied.
 */
let gate: Promise<void> = Promise.resolve();
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn);
  gate = run.then<void, void>(
    () => sleep(MIN_INTERVAL_MS).then(() => undefined),
    () => sleep(MIN_INTERVAL_MS).then(() => undefined),
  );
  return run;
}

interface TransientInfo {
  transient: boolean;
  /** A cap that waiting cannot clear — abandon the run rather than grind. */
  exhausted: boolean;
  /** Server-suggested wait, when the error carries one. */
  retryAfterMs?: number;
}

/**
 * Daily caps, which no amount of backoff will clear.
 *
 * Deliberately narrower than "message contains the word quota": Gemini opens
 * *every* 429 with "You exceeded your current quota", including ordinary
 * per-minute limits that clear in seconds. Matching bare /quota/ would turn each
 * routine rate-limit into a fatal error and abort a 100-app run for nothing, so
 * this keys on per-day wording only.
 */
const DAILY_CAP = /per.?day|daily limit|requests per day|PerDay|GenerateRequestsPerDay/i;

/** 429 (rate limit) and 503 (overloaded) are worth waiting out; 400/401/404 are not. */
function classify(err: unknown): TransientInfo {
  const e = err as { status?: number; code?: number; message?: string };
  const msg = e?.message ?? String(err);
  const status = e.status ?? e.code;

  const rateLimited =
    status === 429 ||
    status === 503 ||
    status === 500 ||
    /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit|quota/i.test(msg);

  const exhausted = rateLimited && DAILY_CAP.test(msg);

  // Gemini returns {"retryDelay":"27s"} inside the error body when it can.
  const m = msg.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i);
  return {
    transient: rateLimited && !exhausted,
    exhausted,
    retryAfterMs: m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined,
  };
}

/** Raised when a daily cap is hit, so callers can stop the whole batch. */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

export interface ExtractOutcome {
  extraction: Extraction | null;
  /** Non-fatal problems worth recording on the row. */
  issues: string[];
}

async function callModel(prompt: string, correcting: boolean): Promise<string> {
  const res = await ai().models.generateContent({
    model: MODEL,
    contents: correcting
      ? `${prompt}\n\nYour previous reply could not be parsed. Reply with ONLY the JSON object required by the schema.`
      : prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0.1,
      systemInstruction:
        'You are a precise API research analyst. Use ONLY the evidence provided in the prompt. ' +
        'If the evidence does not support a field, say so through the confidence field rather than guessing. ' +
        'Never invent a URL.',
    },
  });
  return res.text ?? '';
}

/**
 * Ask Gemini for one structured row.
 *
 * Two separate failure modes, handled differently:
 *   - transient (429 / 503): wait and retry the same request, up to 5 times with
 *     exponential backoff plus jitter, honouring the server's retryDelay.
 *   - bad output: retry once with a blunt correction, then give up.
 *
 * Throws only QuotaExhaustedError, which is deliberately fatal. Every other
 * failure returns { extraction: null } — one unparseable app must not take down
 * a 100-app run, but a daily cap should stop it immediately.
 */
export async function extract(prompt: string): Promise<ExtractOutcome> {
  const issues: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string | null = null;

    for (let tryN = 0; tryN <= MAX_TRANSIENT_RETRIES; tryN++) {
      try {
        text = await throttle(() => callModel(prompt, attempt > 0));
        break;
      } catch (err) {
        const { transient, exhausted, retryAfterMs } = classify(err);

        // A daily cap will not clear within this run. Stop immediately rather
        // than burn retries and fill 100 rows with false low-confidence marks.
        if (exhausted) {
          throw new QuotaExhaustedError(
            `Gemini daily quota exhausted for ${MODEL}.\n  ${(err as Error).message?.replace(/\s+/g, ' ').slice(0, 200)}\n` +
              `  Results already written are kept. Resume tomorrow, switch GEMINI_MODEL, or use a billed key.`,
          );
        }

        if (!transient || tryN === MAX_TRANSIENT_RETRIES) {
          issues.push(`model-error: ${(err as Error).message?.slice(0, 120)}`);
          break;
        }
        // 2s, 4s, 8s, 16s, 32s (+ up to 1s jitter). The server's own retryDelay
        // wins when it asks for *longer*, but never shortens the wait: Gemini
        // sometimes returns "retryDelay":"0s" on a hard quota denial, and
        // obeying that literally burns every retry in a few milliseconds.
        const exponential = 2000 * 2 ** tryN + Math.random() * 1000;
        const backoff = Math.max(exponential, retryAfterMs ?? 0);
        const status = (err as { status?: number }).status ?? '?';
        issues.push(`transient-${status}-retry-${tryN + 1}`);
        console.warn(
          `  [gemini] ${status} — ${retryAfterMs ? 'server asked for' : 'backing off'} ` +
            `${Math.round(backoff / 1000)}s — ${(err as Error).message?.replace(/\s+/g, ' ').slice(0, 90)}`,
        );
        await sleep(backoff);
      }
    }

    if (text === null) break; // hard failure, not worth a correction pass

    try {
      const parsed = coerceExtraction(JSON.parse(text));
      if (parsed) {
        if (attempt > 0) issues.push('bad-json-retried');
        return { extraction: parsed, issues };
      }
      issues.push(attempt === 0 ? 'unusable-json' : 'unusable-json-after-retry');
    } catch {
      issues.push(attempt === 0 ? 'unparseable-json' : 'unparseable-json-after-retry');
    }
  }

  return { extraction: null, issues };
}

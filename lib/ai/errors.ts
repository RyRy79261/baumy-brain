import { APICallError, JSONParseError, NoObjectGeneratedError, TypeValidationError } from 'ai'

// Which LLM failures may degrade to a safe default, and which must propagate (I2).
//
// Every hot-path generateObject is best-effort so one malformed object can't crash-loop ingest
// (AGENTS.md). But a TRANSIENT provider error — 429 / 529 overloaded / timeout / network, after
// the AI SDK's own retries are spent — is not "the model said something unusable": swallowing it
// returns the safe default from a step that then COMPLETES, Inngest memoizes the degraded value,
// and `retries: 3` never re-runs it. A two-minute Anthropic overload used to lose every reminder,
// list op and fact posted during it, silently. So: only a malformed OBJECT degrades; anything
// else is rethrown so the enclosing Inngest step retries.

// The model answered, but the answer doesn't fit the schema (wrapped under an extra key, missing
// a field, invalid JSON). Retrying the same prompt tends to fail the same way — degrade instead.
export function isMalformedObjectError(err: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(err) || TypeValidationError.isInstance(err) || JSONParseError.isInstance(err)) return true
  // Belt for wrapped/re-thrown copies that lost their class identity (e.g. across a bundle
  // boundary) — match the SDK's own messages, never a generic "failed".
  return err instanceof Error && /no\s*object\s*generated|did not match (the )?schema|schema mismatch|type\s*validation|json\s*parse/i.test(err.message)
}

// A provider refusal that no retry can fix (a 4xx other than 408 timeout / 409 / 429 rate-limit —
// e.g. a tool the account doesn't have enabled). Only for OPTIONAL enrichments that have a real
// fallback (web search → the memory-only reply); the hot path still rethrows these.
export function isPermanentProviderError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false
  if (err.isRetryable) return false
  const s = err.statusCode ?? 0
  return s >= 400 && s < 500 && s !== 408 && s !== 409 && s !== 429
}

// For a generateText enrichment that HAS a deterministic fallback (/weekly → the digest, /guests →
// the raw list, a heads-up → none): fall back on output that is unusable OR a provider refusal no
// retry can fix (a 400 prompt-too-long as memory grows, 401, model-not-found) — rethrowing those
// only burned the step's retries and left the user with nothing. A TRANSIENT error (429 / 5xx /
// timeout / network) still rethrows so the step retries (I2). generateText never throws the
// malformed-object errors, so a catch that only accepted those made the fallback unreachable.
export function textFallbackAllowed(err: unknown): boolean {
  return isMalformedObjectError(err) || isPermanentProviderError(err)
}

// The shared guard: degrade (log + return the fallback) on a malformed object, rethrow anything
// else. `label` names the call site in the log line.
export function degradeOnMalformed<T>(err: unknown, label: string, fallback: T): T {
  if (!isMalformedObjectError(err)) throw err
  console.error(`[baumy/${label}] malformed model output — degrading to the safe default:`, err)
  return fallback
}

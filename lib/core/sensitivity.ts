// Deterministic sensitivity scan (D-sec). Flags genuinely-secret house info so
// it's encrypted at rest (app-side AES-GCM) and never volunteered/broadcast.
// ADVISORY for storage/redaction only — NOT a security boundary (the write-gate is).

const PATTERNS: RegExp[] = [
  /\b(wi-?fi|wireless)\b[^.]*\b(password|pass|key|code)\b/i,
  /\b(door|gate|alarm|lock|entry|building|garage)\s*(code|pin|combo|combination)\b/i,
  /\bpassword\s*(is\b|:|=)/i,
  /\b(pin|passcode)\b[^.]{0,12}?\d{3,}/i,
  /\b(iban|account\s*(number|no)\.?|sort\s*code|routing\s*number|card\s*number)\b/i,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // 16-digit card number
  // Any other numeric code stated with its value — "the boiler code is 4821", "bike lock combo: 0912",
  // and the extracted triple "boiler code 4821". The door/gate pattern above only knows its own nouns.
  // A code that is plainly NOT a secret ("zip code 90210", "area code 030", "error code 404") is left
  // alone — encrypting it would leave only "a numeric code" to recall.
  /(?<!\b(?:zip|post|postal|area|country|dialling|dialing|error|status|exit|dress|promo|discount|voucher|coupon|tracking|reference|colou?r|tax)[\s-]*)\b(code|combo|combination)\b[^.\d]{0,12}?\d{3,}/i,
]

// Non-secret descriptors, parallel to PATTERNS. Stored as the memory item's
// content + embedded in place of the plaintext secret, so recall can still find
// "what's the wifi password?" without the value ever touching the vector store.
const DESCRIPTORS: string[] = [
  'the wifi password',
  'an entry/door code',
  'a saved password',
  'a PIN/passcode',
  'bank/account details',
  'a card number',
  'a numeric code',
]

// Invariant: PATTERNS[i] ↔ DESCRIPTORS[i]. A new pattern without a matching descriptor would
// return descriptor:undefined, which capture would then STORE + embed as a secret's content —
// fail loud at load instead.
if (PATTERNS.length !== DESCRIPTORS.length) {
  throw new Error('[baumy/sensitivity] PATTERNS and DESCRIPTORS must stay index-parallel')
}

export interface SensitivityResult {
  isSecure: boolean
  /** Index of the matching pattern, or -1. */
  matched: number
  /** Non-secret descriptor for a secure hit (e.g. "the wifi password"), else ''. */
  descriptor: string
}

export function scanSensitivity(text: string | null | undefined): SensitivityResult {
  if (!text) return { isSecure: false, matched: -1, descriptor: '' }
  // Extracted fact triples arrive with snake_case predicates ("wifi has_password hunter3", "front
  // door door_code 4821"); `\b` and `\s*` never match across "_", so the scan read those as not
  // secret — stored the value in plaintext and echoed it in an ack. Treat "_" as a word break.
  const t = text.replace(/_/g, ' ')
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].test(t)) return { isSecure: true, matched: i, descriptor: DESCRIPTORS[i] }
  }
  return { isSecure: false, matched: -1, descriptor: '' }
}

// A QUESTION that merely mentions a secret ("what's the wifi password again?") is not a secret.
// scanSensitivity is pattern-based, so capturing it stored the QUESTION encrypted under the
// descriptor "the wifi password" — every repeat added another fake "secret", and at reply time
// grounding decrypted them to "the wifi password: what's the wifi password again?", crowding out
// the real value (I9). Such a message is NOT captured at all: storing it in plaintext instead
// could leak a value embedded in the question ("is the wifi password still hunter2?").
// `intent` is the classifier's; a trailing "?" is the deterministic backstop for a degraded verdict
// (never overriding an explicit 'fact' — "wifi password is hunter2 now, ok?" is still a statement).
export function isSecretQuestion(text: string | null | undefined, intent: string): boolean {
  if (!text) return false
  const asks = intent === 'question' || (intent !== 'fact' && intent !== 'statement' && /\?\s*$/.test(text.trim()))
  return asks && scanSensitivity(text).isSecure
}

// Does this QUESTION ask for the value behind a stored secret (C15)? Secure rows are decrypted into a
// reply's grounding ONLY when it does — never because the message merely mentions the same thing
// ("baumy the front door is sticking again" must not put the door code in front of the model).
// `secretLabel` is the secure row's non-secret descriptor ("the wifi password", "front door code").
// Match = the question names the same thing (a shared keyword) AND asks for a secret-ish attribute
// (password / code / pin / iban …) — or names the wifi, which people ask for bare ("what's the wifi?").
const SECRET_THINGS = ['wifi', 'wi-fi', 'wireless', 'door', 'gate', 'alarm', 'lock', 'garage', 'building', 'entry', 'bank', 'iban', 'card', 'account', 'router', 'safe']
const SECRET_ATTRS = /\b(password|pass|passcode|code|pin|key|combo|combination|iban|number|details|login)\b/i
export function asksForSecret(question: string | null | undefined, secretLabel: string): boolean {
  if (!question) return false
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z-]*/g) ?? [])
  const q = words(question)
  const label = words(secretLabel)
  const shared = SECRET_THINGS.filter((t) => q.has(t) && label.has(t))
  if (shared.length === 0) {
    // A bare attribute ("what's the password?") matches a row whose label names that attribute.
    const attr = question.match(SECRET_ATTRS)?.[1]?.toLowerCase()
    return attr != null && label.has(attr) && /\b(what|what's|whats|tell|give|send|remind|need)\b/i.test(question)
  }
  if (SECRET_ATTRS.test(question)) return true
  // "what's the wifi?" / "send me the iban" — the bare thing, but plainly asking for it.
  return shared.some((t) => t === 'wifi' || t === 'wi-fi' || t === 'wireless' || t === 'iban') && ASKS_FOR.test(question)
}
const ASKS_FOR = /\b(what'?s|what is|whats|tell me|give me|send me|need|remind me of)\b/i

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
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].test(text)) return { isSecure: true, matched: i, descriptor: DESCRIPTORS[i] }
  }
  return { isSecure: false, matched: -1, descriptor: '' }
}

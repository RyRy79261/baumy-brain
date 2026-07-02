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

export interface SensitivityResult {
  isSecure: boolean
  /** Index of the matching pattern, or -1. */
  matched: number
}

export function scanSensitivity(text: string | null | undefined): SensitivityResult {
  if (!text) return { isSecure: false, matched: -1 }
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].test(text)) return { isSecure: true, matched: i }
  }
  return { isSecure: false, matched: -1 }
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// App-side secure-value encryption (memory-core #15 / security C8). AES-256-GCM
// with the key held in the app env (BAUMY_ENCRYPTION_KEY = base64 of 32 bytes) —
// NOT in the DB, so a database dump alone is useless. The stored blob is
// base64( iv(12) || authTag(16) || ciphertext ). Single key, no rotation in v1
// (memory-core open-Q resolved): rotating the key makes existing secrets
// undecryptable, so treat it as a durable secret.
function key(): Buffer {
  const b64 = process.env.BAUMY_ENCRYPTION_KEY
  if (!b64) throw new Error('[baumy/crypto] BAUMY_ENCRYPTION_KEY not set')
  const k = Buffer.from(b64, 'base64')
  if (k.length !== 32) throw new Error('[baumy/crypto] BAUMY_ENCRYPTION_KEY must decode to 32 bytes (use `openssl rand -base64 32`)')
  return k
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

// Throws on a tampered blob or wrong key (GCM auth-tag failure) — fail closed.
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

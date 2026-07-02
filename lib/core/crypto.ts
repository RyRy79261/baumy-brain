import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// App-side secure-value encryption (memory-core #15 / security C8). AES-256-GCM
// with the key held in the app env (BAUMY_ENCRYPTION_KEY) — NOT in the DB, so a
// database dump alone is useless. The stored blob is
// base64( iv(12) || authTag(16) || ciphertext ). Single key, no rotation in v1
// (memory-core open-Q resolved): rotating the key makes existing secrets
// undecryptable, so treat it as a durable secret.
function key(): Buffer {
  const raw = process.env.BAUMY_ENCRYPTION_KEY
  if (!raw) throw new Error('[baumy/crypto] BAUMY_ENCRYPTION_KEY not set')
  // Derive the 32-byte AES-256 key from the secret via SHA-256, so ANY
  // sufficiently-random value works — hex (`openssl rand -hex 24`), base64
  // (`... -base64 32`), or a passphrase. No exact-length/encoding requirement.
  return createHash('sha256').update(raw, 'utf8').digest()
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

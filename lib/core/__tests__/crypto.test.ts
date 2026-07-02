import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/core/crypto'

beforeAll(() => {
  process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
})

describe('secure-value crypto (AES-256-GCM)', () => {
  it('round-trips a secret; the blob is ciphertext, not plaintext', () => {
    const secret = 'wifi: hunter2-Berlin!'
    const blob = encryptSecret(secret)
    expect(blob).not.toContain('hunter2')
    expect(decryptSecret(blob)).toBe(secret)
  })

  it('uses a fresh IV each call (same input → different ciphertext)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('rejects a tampered blob (GCM auth-tag failure → throws, fail closed)', () => {
    const buf = Buffer.from(encryptSecret('door code 4821'), 'base64')
    buf[buf.length - 1] ^= 0xff // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString('base64'))).toThrow()
  })
})

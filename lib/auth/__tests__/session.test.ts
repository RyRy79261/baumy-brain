import { describe, it, expect, beforeAll } from 'vitest'
import { signSession, verifySession } from '@/lib/auth/session'

beforeAll(() => {
  process.env.BAUMY_SESSION_SECRET = 'test-session-secret-abcdef0123456789'
})

describe('session HMAC', () => {
  it('round-trips a valid session', () => {
    expect(verifySession(signSession('12345'))?.uid).toBe('12345')
  })

  it('rejects a tampered signature', () => {
    const t = signSession('12345')
    const tampered = t.slice(0, -2) + (t.endsWith('a') ? 'bb' : 'aa')
    expect(verifySession(tampered)).toBeNull()
  })

  it('rejects a forged payload reusing a real signature', () => {
    const [, sig] = signSession('12345').split('.')
    const forged = Buffer.from(JSON.stringify({ uid: '99999', exp: 9_999_999_999 })).toString('base64url') + '.' + sig
    expect(verifySession(forged)).toBeNull()
  })

  it('rejects an expired session', () => {
    expect(verifySession(signSession('12345', -10))).toBeNull()
  })

  it('rejects garbage', () => {
    expect(verifySession('')).toBeNull()
    expect(verifySession('nope')).toBeNull()
    expect(verifySession(null)).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { embed, embedMany, embedSync, EMBED_DIM } from '@/lib/ai/embed'

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

describe('local embeddings (dependency-free)', () => {
  it('produces a unit-normalized vector of the right dimension', async () => {
    const v = await embed('rent is due friday')
    expect(v).toHaveLength(EMBED_DIM)
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5)
  })

  it('is deterministic (same text → same vector)', () => {
    expect(embedSync('wifi password')).toEqual(embedSync('wifi password'))
  })

  it('scores related text higher than unrelated (cosine)', () => {
    const q = embedSync('when is the rent due')
    const near = embedSync('rent is due on friday')
    const far = embedSync('we are out of oat milk')
    expect(cos(q, near)).toBeGreaterThan(cos(q, far))
  })

  it('subword overlap survives typos/word-forms (rents ~ rent)', () => {
    expect(cos(embedSync('rent'), embedSync('rents'))).toBeGreaterThan(cos(embedSync('rent'), embedSync('milk')))
  })

  it('embedMany short-circuits on empty input, else one vector per value', async () => {
    expect(await embedMany([])).toEqual([])
    expect(await embedMany(['a', 'b'])).toHaveLength(2)
  })
})

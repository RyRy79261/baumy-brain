import { describe, it, expect, vi, afterEach } from 'vitest'
import { embed, embedMany, embedSync, EMBED_DIM, EMBED_MODEL } from '@/lib/ai/embed'

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

describe('embedSync — deterministic lexical embedder (tests / fallback)', () => {
  it('produces a unit-normalized vector of EMBED_DIM', () => {
    const v = embedSync('rent is due friday')
    expect(v).toHaveLength(EMBED_DIM)
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5)
  })
  it('is deterministic and scores related > unrelated', () => {
    expect(embedSync('wifi password')).toEqual(embedSync('wifi password'))
    const q = embedSync('when is the rent due')
    expect(cos(q, embedSync('rent is due on friday'))).toBeGreaterThan(cos(q, embedSync('we are out of oat milk')))
  })
})

describe('embed — Voyage 3.5-lite via fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.VOYAGE_API_KEY
  })

  it('calls the Voyage API with the model + dimension and returns the vector', async () => {
    process.env.VOYAGE_API_KEY = 'vk-test'
    let captured: { url: string; body: Record<string, unknown>; auth: string } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        captured = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
        return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) } as unknown as Response
      }),
    )
    const v = await embed('hello house')
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(captured!.url).toContain('voyageai.com')
    expect(captured!.body.model).toBe(EMBED_MODEL)
    expect(captured!.body.output_dimension).toBe(EMBED_DIM)
    expect(captured!.auth).toBe('Bearer vk-test')
  })

  it('throws without a key (never silently degrades into a different embedding space)', async () => {
    await expect(embed('x')).rejects.toThrow(/VOYAGE_API_KEY/)
  })

  it('embedMany short-circuits on empty input (no API call)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await embedMany([])).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
})

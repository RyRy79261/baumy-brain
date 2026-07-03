// Semantic embeddings (memory issue #1). PRODUCTION uses Voyage 3.5-lite over a
// plain fetch() — no vendor SDK, no native module, no bundle/cold-start risk on
// Vercel Hobby (the local-transformer route fails the 250MB build; verified). The
// deterministic lexical hash embedder below is kept ONLY for tests + as a
// documented no-vendor fallback — it is NEVER mixed into production vectors
// (mixing embedding spaces in one column is meaningless), so embed() throws on a
// Voyage failure rather than silently degrading.
export const EMBED_DIM = 512
export const EMBED_MODEL = 'voyage-3.5-lite'

// ── Production embedder: Voyage 3.5-lite ─────────────────────────
export async function embed(text: string): Promise<number[]> {
  const [v] = await embedMany([text])
  if (!v) throw new Error('[baumy/embed] voyage returned no embedding')
  return v
}

export async function embedMany(values: string[]): Promise<number[][]> {
  if (values.length === 0) return []
  const key = process.env.VOYAGE_API_KEY
  if (!key) throw new Error('[baumy/embed] VOYAGE_API_KEY not set')
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: values, model: EMBED_MODEL, output_dimension: EMBED_DIM }),
  })
  if (!res.ok) {
    throw new Error(`[baumy/embed] voyage ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
  // Voyage tags each item with its request `index`; sort by it rather than trusting
  // array order, so a returned vector is never paired with the wrong input.
  return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// ── Deterministic lexical embedder (TESTS + no-vendor fallback) ──
// Feature-hashed bag of word + char-trigram features, signed hashing, L2-normed.
function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function features(text: string): string[] {
  const out: string[] = []
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  for (const tok of tokens) {
    out.push(`w:${tok}`)
    const padded = `#${tok}#`
    for (let i = 0; i + 3 <= padded.length; i++) out.push(`t:${padded.slice(i, i + 3)}`)
  }
  return out
}

export function embedSync(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0)
  for (const f of features(text)) {
    const idx = hash32(f) % EMBED_DIM
    const sign = (hash32(`${f}#sign`) & 1) === 0 ? 1 : -1
    v[idx] += sign
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

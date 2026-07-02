// Local, dependency-free embeddings (Phase 7). NO external vendor, NO API key —
// runs in-process, deterministic, instant, and deploys anywhere (no native
// modules, no model download). Approach: a feature-hashed bag of word + char-
// trigram features with signed hashing, L2-normalized, so cosine similarity ≈
// weighted lexical + subword overlap. That handles word-forms and typos
// (rent/rents, wifi/wi-fi) — plenty at house scale. The embed() seam is
// unchanged, so a local transformer model can be swapped in later (see SETUP)
// without touching any caller.
export const EMBED_DIM = 384
export const EMBED_MODEL = 'baumy-local-hash-v1'

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
    out.push(`w:${tok}`) // whole word
    const padded = `#${tok}#`
    for (let i = 0; i + 3 <= padded.length; i++) out.push(`t:${padded.slice(i, i + 3)}`) // char trigrams
  }
  return out
}

export function embedSync(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0)
  for (const f of features(text)) {
    const idx = hash32(f) % EMBED_DIM
    const sign = (hash32(`${f}#sign`) & 1) === 0 ? 1 : -1 // signed hashing curbs collision bias
    v[idx] += sign
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

export async function embed(text: string): Promise<number[]> {
  return embedSync(text)
}

export async function embedMany(values: string[]): Promise<number[][]> {
  return values.map(embedSync)
}

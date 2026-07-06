import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { type Database } from '@/db/client'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve, retrieveExpanded } from '@/lib/memory/retrieve'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { gatherGraphContext } from '@/lib/memory/graph'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync, embedMany as voyageEmbedMany, EMBED_MODEL } from '@/lib/ai/embed'

// ───────────────────────────────────────────────────────────────────────────────
// RETRIEVAL ABLATION HARNESS (research instrument, NOT a CI test — env-gated).
//
// Purpose: the docs/research corpus makes load-bearing claims about retrieval
// (hybrid RRF beats single arms; expansion widens recall; the facts arm and the
// graph walk add reach) that were, until this file, argued only theory-vs-theory
// (see docs/research/05-methodology-review.md, anti-pattern #3: zero empirical
// contact). This harness runs the REAL pipeline — production write path
// (captureMemory/reconcileFact) and read path (retrieve/retrieveExpanded/
// currentFactsForQuery/gatherGraphContext) on PGlite — over a realistic house
// corpus and a labeled query set, and reports hit-rates per variant.
//
// Run (offline, deterministic lexical embedder):
//   RUN_ABLATION=1 pnpm vitest run scripts/ablation
// Run in the REAL production embedding space (Voyage; needs the key — costs ~a cent):
//   RUN_ABLATION=1 ABLATION_EMBEDDER=voyage VOYAGE_API_KEY=... pnpm vitest run scripts/ablation
//
// VALIDITY CAVEATS (also in docs/research/06-empirical-ablation.md):
// - The lexical run's "semantic" arm uses embedSync — a *lexical hash*, so it
//   under-credits true semantic paraphrase recall. The Voyage run is the honest
//   semantic measurement; the lexical run still measures pipeline STRUCTURE
//   (fusion, floors, recency, facts/graph arms) faithfully.
// - Queries + relevance labels were authored by the same model family that wrote
//   the research (disclosed). Humans are invited to perturb: add queries to
//   scripts/ablation/queries.human.json (see the template) and re-run.
// - Arm-isolation variants (semantic-only / lexical-only) copy the respective CTE
//   of lib/memory/retrieve.ts's production SQL (drift risk: keep in sync by hand).
// ───────────────────────────────────────────────────────────────────────────────

const RUN = !!process.env.RUN_ABLATION
const suite = RUN ? describe : describe.skip
const USE_VOYAGE = process.env.ABLATION_EMBEDDER === 'voyage'

process.env.BAUMY_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64')
const GROUP = '-100ablation'
const K = 8

// Batched embedder wrappers so the Voyage run doesn't fire 100 sequential calls.
const embedOne = USE_VOYAGE ? async (t: string) => (await voyageEmbedMany([t]))[0] : async (t: string) => embedSync(t)
const embedBatch = USE_VOYAGE ? voyageEmbedMany : async (ts: string[]) => ts.map(embedSync)

// ── The house corpus ──────────────────────────────────────────────────────────
// Realistic shared-house memory. `marker` = the substring used as this item's
// ground-truth identity in relevance labels (must survive capture verbatim).
interface SeedNote {
  content: string
  type: 'fact' | 'chatter' | 'question' | 'reminder'
  by: string | null
  ageDays: number
  salience?: number
}

const NOTES: SeedNote[] = [
  // -- F1 exact-term targets
  { content: 'the wifi password is hunter2-berlin-42', type: 'fact', by: '10', ageDays: 90 }, // → secure descriptor
  { content: 'rent is due on the 3rd of every month, transfer to the shared account', type: 'fact', by: '20', ageDays: 60 },
  { content: 'landlord Herr Weber phone number is 030-555-7788', type: 'fact', by: '10', ageDays: 120 },
  { content: 'the boiler reset button is behind the white panel in the bathroom', type: 'fact', by: '30', ageDays: 45 },
  // -- F2 paraphrase targets (stored wording deliberately ≠ query wording)
  { content: 'the dryer is broken again, do not use it until the technician comes', type: 'fact', by: '20', ageDays: 4 },
  { content: 'Zuzka is arriving on the 14th and staying in my room for two nights', type: 'fact', by: '10', ageDays: 6 },
  { content: 'we switched the electricity contract to Vattenfall last week', type: 'fact', by: '30', ageDays: 12 },
  { content: 'the spare key is under the blue flowerpot on the left of the door', type: 'fact', by: '20', ageDays: 200 },
  { content: 'quiet hours are after 10pm on weekdays, neighbours complained twice', type: 'fact', by: '10', ageDays: 80 },
  // -- F5 supersession/recency pair (stale vs current)
  { content: 'bins go out on friday morning, blue bin is paper', type: 'fact', by: '20', ageDays: 400 },
  { content: 'heads up the council changed collection, bins now go out monday night', type: 'fact', by: '30', ageDays: 3 },
  // -- F3/F4 people + graph texture
  { content: 'Marta is a nurse at the Charité, she works night shifts most weeks', type: 'fact', by: '10', ageDays: 30 },
  { content: 'Marta fixed the kitchen sink on tuesday, still smug about it', type: 'chatter', by: '30', ageDays: 9 },
  { content: 'Miso the cat gets fed twice a day, Marta usually does mornings', type: 'fact', by: '20', ageDays: 25 },
  { content: 'Charl moved into the attic room, the one with the skylight', type: 'fact', by: '10', ageDays: 150 },
  // -- ambient chatter (noise floor — never a target)
  { content: 'lol did anyone see the fox in the garden last night', type: 'chatter', by: '30', ageDays: 2, salience: 0.35 },
  { content: 'pizza night friday? thinking the usual place', type: 'chatter', by: '20', ageDays: 1, salience: 0.35 },
  { content: 'my plant is dying again send help', type: 'chatter', by: '10', ageDays: 5, salience: 0.35 },
  { content: 'the hallway lightbulb flickers sometimes but comes back', type: 'chatter', by: '30', ageDays: 33, salience: 0.35 },
  { content: 'someone left the oven on again this morning, please check before leaving', type: 'chatter', by: '20', ageDays: 15, salience: 0.35 },
]

// Graph edges via the real fact pipeline (drives F3 multi-hop + F4 fact lookups).
const FACTS: Array<{ subject: string; sk?: 'person' | 'place' | 'thing'; predicate: string; object: string; ok?: 'person' | 'place' | 'thing' | 'value' }> = [
  { subject: 'zuzka', sk: 'person', predicate: 'sibling_of', object: 'charl', ok: 'person' },
  { subject: 'charl', sk: 'person', predicate: 'lives_in', object: 'the attic room', ok: 'place' },
  { subject: 'marta', sk: 'person', predicate: 'works_as', object: 'nurse at the Charité', ok: 'value' },
  { subject: 'marta', sk: 'person', predicate: 'feeds', object: 'miso', ok: 'person' },
  { subject: 'miso', sk: 'person', predicate: 'is', object: 'the house cat', ok: 'value' },
  { subject: 'bins', predicate: 'go_out', object: 'monday night', ok: 'value' },
  { subject: 'rent', predicate: 'due_on', object: '3rd of every month', ok: 'value' },
]

// ── The query set ─────────────────────────────────────────────────────────────
// family → which research claim it tests. `relevant` = markers (substrings of the
// stored content / fact) that count as a hit. First marker = the primary target.
interface Query {
  q: string
  family: 'F1-exact' | 'F2-paraphrase' | 'F3-multihop' | 'F4-fact' | 'F5-supersession' | 'F6-colloquial'
  relevant: string[]
  expansions: string[] // hand-authored stand-ins for expand.ts (Sonnet) output — disclosed
}

const QUERIES: Query[] = [
  // F1 — exact-term (claim: the lexical arm carries verbatim asks)
  { q: 'what is the wifi password?', family: 'F1-exact', relevant: ['wifi password'], expansions: ['wifi network key', 'password for the internet'] },
  { q: 'when is rent due?', family: 'F1-exact', relevant: ['rent is due on the 3rd', '3rd of every month'], expansions: ['rent payment date', 'when do we pay rent'] },
  { q: 'landlord phone number?', family: 'F1-exact', relevant: ['030-555-7788'], expansions: ['how to contact the landlord', 'Herr Weber contact'] },
  { q: 'where is the boiler reset button?', family: 'F1-exact', relevant: ['boiler reset button'], expansions: ['restart the heating', 'boiler panel location'] },
  // F2 — paraphrase (claim: the semantic arm carries re-worded asks; embedSync will under-perform here — expected)
  { q: 'is the laundry machine out of order?', family: 'F2-paraphrase', relevant: ['dryer is broken'], expansions: ['is the dryer working', 'broken appliance laundry'] },
  { q: 'when does our guest get here?', family: 'F2-paraphrase', relevant: ['Zuzka is arriving on the 14th'], expansions: ['visitor arrival date', 'when is Zuzka coming'] },
  { q: 'who supplies our power now?', family: 'F2-paraphrase', relevant: ['Vattenfall'], expansions: ['electricity provider', 'energy company contract'] },
  { q: "where's the extra house key hidden?", family: 'F2-paraphrase', relevant: ['spare key is under the blue flowerpot'], expansions: ['spare key location', 'hidden key outside the door'] },
  { q: 'how late can we play music?', family: 'F2-paraphrase', relevant: ['quiet hours are after 10pm'], expansions: ['noise curfew', 'quiet hours neighbours'] },
  // F3 — multi-hop (claim: the graph walk reaches what no single lookup returns)
  { q: "where is charl's sister staying?", family: 'F3-multihop', relevant: ['attic room', 'staying in my room'], expansions: ['zuzka accommodation', 'where does zuzka sleep'] },
  { q: 'who looks after miso?', family: 'F3-multihop', relevant: ['marta feeds miso', 'Marta usually does mornings'], expansions: ['who feeds the cat', 'cat care rota'] },
  { q: 'which room does charl have?', family: 'F3-multihop', relevant: ['attic room'], expansions: ['charl bedroom', 'who lives in the attic'] },
  // F4 — fact lookup (claim: the structured-facts arm answers "who is X")
  // marker 'sibling of' (not 'sibling of charl') — the fact renderer emits "zuzka sibling of: charl"
  { q: 'who is zuzka?', family: 'F4-fact', relevant: ['sibling of', 'sibling_of'], expansions: ['zuzka relation to the house', 'whose sister is zuzka'] },
  { q: "what is marta's job?", family: 'F4-fact', relevant: ['nurse'], expansions: ['what does marta do for work', 'marta profession'] },
  { q: 'what is miso?', family: 'F4-fact', relevant: ['house cat'], expansions: ['who is miso', 'miso the pet'] },
  // F5 — supersession/recency (claim: recency composition + fact supersession prefer the CURRENT value)
  { q: 'which day do the bins go out?', family: 'F5-supersession', relevant: ['monday night'], expansions: ['bin collection day', 'when is rubbish collected'] },
  { q: 'is it paper bin this week?', family: 'F5-supersession', relevant: ['monday night', 'blue bin is paper'], expansions: ['which bin goes out', 'recycling schedule'] },
  // F6 — colloquial / typo (claim: hybrid degrades gracefully off-distribution)
  { q: 'wat was that wifi pass again lol', family: 'F6-colloquial', relevant: ['wifi password'], expansions: ['wifi password', 'internet password'] },
  { q: 'bins tmrw??', family: 'F6-colloquial', relevant: ['monday night'], expansions: ['bin day', 'when do bins go out'] },
  { q: "who's got the landlords number", family: 'F6-colloquial', relevant: ['030-555-7788'], expansions: ['landlord phone', 'contact Herr Weber'] },
]

// Optional human-authored queries (the "squishy human randomness" channel): add
// entries to queries.human.json (same shape as Query) and re-run.
function loadHumanQueries(): Query[] {
  const p = join(__dirname, 'queries.human.json')
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { queries?: Query[] }
    return (parsed.queries ?? []).filter((q) => q.q && Array.isArray(q.relevant) && q.relevant.length > 0)
  } catch {
    return []
  }
}

// ── Arm isolation (diagnostic only) ───────────────────────────────────────────
// Faithful copies of the respective CTE from lib/memory/retrieve.ts runHybrid
// (same filters: group-scoped, active, non-quarantined, current model). Used ONLY
// to isolate arms; every headline variant goes through the real public API.
async function semanticOnly(db: Database, vec: number[], k: number): Promise<string[]> {
  const v = `[${vec.join(',')}]`
  const res = await db.execute(sql`
    SELECT mi.content AS content
    FROM baumy_memory_embeddings me
    JOIN baumy_memory_items mi ON mi.id = me.memory_item_id
    WHERE mi.group_id = ${GROUP} AND mi.is_active = true AND mi.trust_level <> 'quarantined' AND me.model = ${EMBED_MODEL}
    ORDER BY me.embedding <=> ${v}::vector
    LIMIT ${k}`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => String(r.content))
}

async function lexicalOnly(db: Database, q: string, k: number): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT mi.content AS content
    FROM baumy_memory_items mi
    WHERE mi.group_id = ${GROUP} AND mi.is_active = true AND mi.trust_level <> 'quarantined'
      AND mi.content_tsv @@ websearch_to_tsquery('english', ${q})
    ORDER BY ts_rank_cd(mi.content_tsv, websearch_to_tsquery('english', ${q})) DESC
    LIMIT ${k}`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => String(r.content))
}

// ── Scoring ───────────────────────────────────────────────────────────────────
const hitRank = (contents: string[], markers: string[]): number => {
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i].toLowerCase()
    if (markers.some((m) => c.includes(m.toLowerCase()))) return i + 1
  }
  return 0 // miss
}

interface VariantScore {
  variant: string
  hitAt1: number
  hitAtK: number
  mrr: number
  perFamily: Record<string, { n: number; hitAtK: number }>
  misses: Array<{ q: string; family: string }>
}

function score(variant: string, results: Map<string, string[]>, queries: Query[]): VariantScore {
  let h1 = 0
  let hk = 0
  let rr = 0
  const fam: Record<string, { n: number; hits: number }> = {}
  const misses: Array<{ q: string; family: string }> = []
  for (const q of queries) {
    const rank = hitRank(results.get(q.q) ?? [], q.relevant)
    fam[q.family] ??= { n: 0, hits: 0 }
    fam[q.family].n++
    if (rank === 1) h1++
    if (rank >= 1) {
      hk++
      rr += 1 / rank
      fam[q.family].hits++
    } else {
      misses.push({ q: q.q, family: q.family })
    }
  }
  const n = queries.length
  return {
    variant,
    hitAt1: +(h1 / n).toFixed(3),
    hitAtK: +(hk / n).toFixed(3),
    mrr: +(rr / n).toFixed(3),
    perFamily: Object.fromEntries(Object.entries(fam).map(([f, v]) => [f, { n: v.n, hitAtK: +(v.hits / v.n).toFixed(3) }])),
    misses,
  }
}

// ── The run ───────────────────────────────────────────────────────────────────
suite('retrieval ablation (research instrument — RUN_ABLATION=1)', () => {
  it(
    `measures pipeline variants over the house corpus (${USE_VOYAGE ? 'VOYAGE production space' : 'lexical test embedder'})`,
    async () => {
      const db = await makeTestDb()
      await ensureRegistered(db, GROUP, 10)
      await upsertMember(db, GROUP, '10', 'Ryan', 'owner')
      await upsertMember(db, GROUP, '20', 'Marta', 'member')
      await upsertMember(db, GROUP, '30', 'Charl', 'member')

      // Seed notes through the REAL write path, then backdate for recency realism.
      const embed = embedOne
      for (const n of NOTES) {
        await captureMemory(
          { groupId: GROUP, content: n.content, memoryType: n.type, authoredBy: n.by, trustLevel: 'untrusted', salience: n.salience ?? (n.type === 'fact' ? 0.85 : 0.5) },
          { db, embed },
        )
        // marker for backdating = first 24 chars (unique across the corpus)
        await db.execute(sql`UPDATE baumy_memory_items SET created_at = now() - make_interval(days => ${n.ageDays}) WHERE group_id = ${GROUP} AND content LIKE ${n.content.slice(0, 24) + '%'}`)
      }
      // Facts through the REAL reconcile path (entity resolution + graph edges).
      // The stale bins value first, then the current one — exercising supersession.
      await reconcileFact(db, { groupId: GROUP, fact: { subject: 'bins', predicate: 'go_out', object: 'friday morning', objectKind: 'value' }, authoredBy: '20', trustLevel: 'untrusted' })
      for (const f of FACTS) {
        await reconcileFact(db, { groupId: GROUP, fact: { subject: f.subject, subjectKind: f.sk, predicate: f.predicate, object: f.object, objectKind: f.ok }, authoredBy: '10', trustLevel: 'untrusted' })
      }

      const queries = [...QUERIES, ...loadHumanQueries()]
      const humanN = queries.length - QUERIES.length

      // Pre-embed all probes (batched — one Voyage call instead of dozens).
      const probeTexts = queries.flatMap((q) => [q.q, ...q.expansions])
      const probeVecs = await embedBatch(probeTexts)
      const vecOf = new Map<string, number[]>()
      probeTexts.forEach((t, i) => vecOf.set(t, probeVecs[i]))
      const cachedEmbed = async (t: string) => vecOf.get(t) ?? embed(t)
      const deps = { db, embed: cachedEmbed, embedMany: async (ts: string[]) => Promise.all(ts.map(cachedEmbed)) }

      // Variants (headline ones go through the REAL public API).
      const variants: Record<string, Map<string, string[]>> = {
        'semantic-only (arm)': new Map(),
        'lexical-only (arm)': new Map(),
        'hybrid (prod shallow)': new Map(),
        'hybrid+expansion (deep)': new Map(),
        'hybrid+facts (prod reply)': new Map(),
        'hybrid+facts+graph (prod deep reply)': new Map(),
      }

      for (const q of queries) {
        const vec = vecOf.get(q.q)!
        variants['semantic-only (arm)'].set(q.q, await semanticOnly(db, vec, K))
        variants['lexical-only (arm)'].set(q.q, await lexicalOnly(db, q.q, K))

        const hybrid = await retrieve(q.q, { groupId: GROUP, k: K, floor: 0.2 }, deps)
        variants['hybrid (prod shallow)'].set(q.q, hybrid.map((m) => m.content))

        const expanded = await retrieveExpanded(q.q, q.expansions, { groupId: GROUP, k: K, floor: 0.05 }, deps)
        variants['hybrid+expansion (deep)'].set(q.q, expanded.map((m) => m.content))

        // Compose exactly like ingest.ts runReplyBody: facts first, then memories.
        const facts = await currentFactsForQuery(db, GROUP, q.q, 5)
        variants['hybrid+facts (prod reply)'].set(q.q, [...facts.map((f) => f.content), ...hybrid.map((m) => m.content)])

        const graph = await gatherGraphContext(db, GROUP, q.q)
        variants['hybrid+facts+graph (prod deep reply)'].set(q.q, [
          ...facts.map((f) => f.content),
          ...expanded.map((m) => m.content),
          ...graph.map((g) => g.content),
        ])
      }

      const scores = Object.entries(variants).map(([name, res]) => score(name, res, queries))

      // Report: console table + JSON artifact beside the research docs.
      const pad = (s: string, n: number) => s.padEnd(n)
      let table = `\n${pad('variant', 38)} hit@1  hit@${K}  MRR\n${'-'.repeat(62)}\n`
      for (const s of scores) table += `${pad(s.variant, 38)} ${pad(String(s.hitAt1), 6)} ${pad(String(s.hitAtK), 6)} ${s.mrr}\n`
      console.log(table)
      for (const s of scores) {
        if (s.misses.length) console.log(`${s.variant} MISSES: ${s.misses.map((m) => `[${m.family}] ${m.q}`).join(' | ')}`)
      }

      const outDir = join(__dirname, '..', '..', 'docs', 'research', 'data')
      mkdirSync(outDir, { recursive: true })
      const artifact = {
        embedder: USE_VOYAGE ? EMBED_MODEL : 'embedSync (lexical hash — test embedder)',
        k: K,
        corpus: { notes: NOTES.length, facts: FACTS.length + 1 },
        queries: { authored: QUERIES.length, human: humanN },
        scores,
        generatedAt: new Date().toISOString(),
      }
      writeFileSync(join(outDir, `ablation-${USE_VOYAGE ? 'voyage' : 'lexical'}.json`), JSON.stringify(artifact, null, 2))
      console.log(`wrote docs/research/data/ablation-${USE_VOYAGE ? 'voyage' : 'lexical'}.json (${humanN} human queries included)`)

      // Sanity only — this is an instrument, not a pass/fail gate.
      expect(scores.length).toBe(6)
      expect(scores.every((s) => s.hitAtK >= 0)).toBe(true)
    },
    240_000,
  )
})

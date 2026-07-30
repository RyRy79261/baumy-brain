import { is, Table } from 'drizzle-orm'
import * as schema from '@/db/schema'

// Column policy for the owner console (docs/spec/sandbox-console.md). EVERY column of EVERY table
// carries a verdict, and the console renders from this map rather than from the schema — so a
// column cannot reach the UI without a deliberate decision, and the drift test fails the build if
// db/schema.ts grows one this file does not mention.
//
// The survey that motivated this is unambiguous: full-row write-back is the root cause of nearly
// every derived-column bug in comparable admin panels, and the generic tools break on precisely
// the column types we have most of (pgvector, tsvector, encrypted blobs, bitemporal chains).

export type ColumnClass =
  // Plain data. Safe to display; the future edit allowlist is drawn from here.
  | 'open'
  // Computed from another column. Display read-only — NEVER hand-write. The correct "edit" is to
  // change the source and let the derivation re-run (Postgres does it for content_tsv; the reembed
  // sweep does it for embeddings).
  | 'derived'
  // The audit + trust substrate. Display read-only: it is worth something only while it is known
  // to be unmodified. Editing these is how you get a memory-poisoning hole or a stale profile.
  | 'provenance'
  // Never selected, never rendered, at any access level.
  | 'secret'

export interface ColumnPolicy {
  cls: ColumnClass
  why?: string
}

type TablePolicy = Record<string, ColumnPolicy>

const open = (why?: string): ColumnPolicy => ({ cls: 'open', why })
const derived = (why: string): ColumnPolicy => ({ cls: 'derived', why })
const prov = (why: string): ColumnPolicy => ({ cls: 'provenance', why })
const secret = (why: string): ColumnPolicy => ({ cls: 'secret', why })

// Shared shapes. Every house-data table is group-scoped, and the scope is derived in code from the
// authenticated lane (never from message text) — so it is provenance, not a free-text field.
const scoped = { groupId: prov('scope — derived from the authenticated lane, never editable') }
const stamped = { createdAt: prov('insert stamp') }

export const POLICY: Record<string, TablePolicy> = {
  telegramChats: {
    chatId: prov('the house identity itself'),
    kind: prov('group|private — half of how the lane is derived'),
    title: open('group title'),
    isPrimary: prov('marks THE house group — the fixed send destination'),
    isActive: prov('deactivated chats are ignored'),
    ...stamped,
  },

  members: {
    telegramUserId: prov('authenticated Telegram id — identity, not a field'),
    ...scoped,
    displayName: open('safe to correct — display only'),
    dmChatId: prov('the authenticated DM destination for this member'),
    deactivatedAt: prov('when the grant lapsed'),
    role: prov('authorization input — owner/admin/member gates privileged surfaces'),
    canAccessDashboard: prov('live authz decision, re-read on every request; change it via the members page, not a grid'),
    isActive: prov('deactivation is an authz decision'),
    ...stamped,
  },

  telegramUpdates: {
    updateId: prov('idempotency key — the exactly-once guard for inbound webhooks'),
    chatId: prov('idempotency key'),
    status: prov('processing state'),
    raw: prov('deliberately never written — storing message bodies here would keep secrets in plaintext at rest'),
    receivedAt: prov('insert stamp'),
  },

  // Declared but never written (no reader or writer outside db/schema.ts). Kept in the policy so
  // the drift test stays green and so a future implementer inherits the verdicts.
  messages: {
    id: prov('surrogate key'),
    ...scoped,
    chatId: prov('where it was said'),
    messageId: prov('Telegram message id'),
    authorMemberId: prov('authenticated sender'),
    text: open('message body'),
    sentAt: prov('when Telegram says it was sent'),
    receivedAt: prov('when we got it'),
  },

  replies: {
    updateId: prov('one-send-per-inbound claim — the reply idempotency guard'),
    sentAt: prov('when the reply went out'),
  },

  houseConfig: {
    id: prov('singleton row'),
    houseGroupChatId: prov('the fixed send destination — code-resolved, never LLM-chosen'),
    houseTimezone: open('house timezone — affects every cron slot and every date resolution'),
    responsePolicy: open('edit via the typed setters on the settings page (pause, confidence floor, muted topics, reminder frequency)'),
    dailySpendCapUsd: open('spend cap'),
    secureKeyVersion: prov('which encryption key is current'),
    updatedAt: prov('last change'),
  },

  auditLog: {
    id: prov('surrogate key'),
    actorMemberId: prov('who did it'),
    action: prov('what happened'),
    target: prov('what it happened to'),
    metadata: prov('the details'),
    createdAt: prov('when — an audit row is only evidence while it is immutable'),
  },

  entities: {
    id: prov('surrogate key'),
    ...scoped,
    canonicalName: open('safe to correct; note the WRITE side is precision-first — a careless merge is how "marta" and "marco" collapse'),
    kind: open('person|place|org|event|thing'),
    aliases: open('alias list — same merge caution as canonicalName'),
    memberId: prov('links an entity to a roster member'),
    isActive: prov('soft-delete flag'),
    nameEmbedding: derived('reserved, unwritten: semantic entity resolution. A vector is only consistent with the text it was computed from'),
    ...stamped,
  },

  memoryItems: {
    id: prov('surrogate key'),
    ...scoped,
    sourceKind: prov('message|fact'),
    sourceMessageId: prov('provenance — which message this evidence came from'),
    memoryType: open('classifier label'),
    content: open('the evidence text. Editing it MUST invalidate the embedding (set it NULL) so the reembed sweep recomputes'),
    authoredBy: prov('who said it — attribution is a trust input, never a free-text field'),
    aboutEntityId: prov('who it is about — feeds reflection'),
    trustLevel: prov('trust tier from the authenticated lane — the injection wall depends on this'),
    isSecure: prov('flips the encryption path; changing it would strand a ciphertext'),
    contentEncrypted: secret('AES-256-GCM blob. The key is not in the DB, GCM fails closed on tamper, and there is no rotation — any edit destroys it irrecoverably'),
    salience: open('ranking weight'),
    accessCount: derived('maintained by retrieval'),
    lastAccessedAt: derived('maintained by retrieval'),
    isActive: prov('soft-delete flag — set it via the forget flow, which is confirm-tap-gated and audited'),
    ...stamped,
    contentTsv: derived('GENERATED ALWAYS … STORED (migration 0006) — Postgres itself rejects a direct write, and it self-heals when content changes'),
  },

  memoryEmbeddings: {
    id: prov('surrogate key'),
    memoryItemId: prov('owner row'),
    model: prov('retrieval filters on model = EMBED_MODEL so the two embedding spaces are never cosine-compared'),
    embedding: derived('512-dim Voyage vector. Application-maintained, so unlike content_tsv Postgres will NOT reject a bad write — a hand-typed vector silently poisons ranking. Fix the text, drop the row, let the reembed sweep recompute'),
  },

  facts: {
    id: prov('surrogate key'),
    ...scoped,
    subjectEntityId: prov('resolved entity — re-resolution is part of a proper edit'),
    predicate: prov('half of the (subject, predicate) identity a supersession chain is keyed on'),
    objectEntityId: prov('set ⇒ this fact is a graph EDGE, not an attribute'),
    objectValue: open('the value — but edit it by writing a SUPERSEDING fact through reconcileFact, never in place (see the spec)'),
    objectJson: open('structured value, same rule'),
    authoredBy: prov('who stated it'),
    trustLevel: prov('the trust gate: a fact may only supersede one of ≤ its own trust. This IS the memory-poisoning defence'),
    isSecure: prov('flips the encryption path'),
    valueCiphertext: secret('AES-256-GCM blob — never displayed, never edited'),
    valueIv: secret('reserved; the IV is packed inside value_ciphertext'),
    keyVersion: prov('which key encrypted the value'),
    eventAt: open('resolved event time — must come from parseEventDate, never a bare chrono call, or the nudge scan surfaces a wrong date'),
    recurrence: open('RRULE-lite, unused today'),
    validFrom: prov('bitemporal validity'),
    validTo: prov('bitemporal validity — closed when superseded'),
    isCurrent: prov('the invariant "one is_current row per (group, subject, predicate)" is enforced in CODE ONLY — there is no unique index, so a hand-edit here permanently surfaces a stale value'),
    supersededBy: prov('forward pointer of the supersession chain'),
    recordedAt: prov('load-bearing, not audit: the reflect cron compares it against a person\'s newest profile, so an edit that leaves it behind freezes that profile stale'),
    invalidatedAt: prov('when it stopped being current'),
    deletedAt: prov('soft delete'),
    sourceMemoryItemId: prov('the evidence note this was extracted from'),
    derivedFromFactId: prov('backward pointer of the supersession chain'),
  },

  reminders: {
    id: prov('surrogate key'),
    ...scoped,
    deliverChatId: prov('code-resolved destination — the LLM never picks a recipient, and neither does a text box'),
    content: open('the line that gets posted'),
    anchorKind: prov('absolute|relative|event_offset — drives the ⏰ vs 🗓️ framing and whether it is armed for near-time delivery'),
    fireAt: open('when it fires — subject to the 24h staleness window'),
    eventFactId: prov('anchoring fact; ON DELETE CASCADE, so deleting that fact vaporises this reminder'),
    leadInterval: open(),
    recurrence: open('unused today'),
    status: prov('scheduled|firing|sent|cancelled|failed — the exactly-once state machine. Hand-editing it can double-send or zero-fire'),
    createdBy: prov('who asked for it'),
    ...stamped,
  },

  scheduledTasks: {
    id: prov('surrogate key'),
    ...scoped,
    prompt: open(),
    cadence: open(),
    nextRunAt: open(),
    lastRunAt: prov('last dispatch'),
    untilExpiry: open(),
    untilCondition: open(),
    requesterMemberId: prov('who asked for it'),
    modelTier: open('assess|advisor'),
    webSearchEnabled: open(),
    isSystem: prov('built-in vs user-defined'),
    isActive: open(),
    ...stamped,
  },

  listItems: {
    id: prov('surrogate key'),
    ...scoped,
    listName: prov('resilience seam — one list today'),
    item: open('display text, verbatim'),
    itemNormalized: derived('lower(trim) dedupe key backing a partial unique index — edit `item` and recompute, never this'),
    addedBy: prov('who put it on the list'),
    checkedBy: prov('who bought it'),
    checkedAt: open('null = still open'),
    isActive: prov('soft-remove'),
    ...stamped,
  },

  prompts: {
    id: prov('surrogate key'),
    name: open(),
    version: prov('version identity'),
    body: open('the prompt text'),
    model: open(),
    params: open(),
    label: open('production|staging style label'),
    contentHash: derived('hash of the body'),
    ...stamped,
  },

  llmUsage: {
    id: prov('surrogate key'),
    role: prov('which model tier ran'),
    model: prov('model id'),
    inputTokens: prov('metered usage — evidence, not a field'),
    outputTokens: prov('metered usage'),
    costNanoUsd: prov('metered usage'),
    updateId: prov('the inbound update this call served'),
    ...stamped,
  },

  dashboardLoginTokens: {
    id: prov('surrogate key'),
    tokenHash: secret('a login credential — never displayed, at any access level'),
    userId: prov('who the link admits'),
    expiresAt: prov('expiry wall'),
    consumedAt: prov('single-use marker'),
    ...stamped,
  },

  pendingActions: {
    id: prov('surrogate key'),
    groupId: prov('scope'),
    actionType: prov('what a tap would execute'),
    payload: prov('the exact proposal a human reviews before tapping — editing it after the fact would defeat the confirm wall'),
    requestedBy: prov('who proposed'),
    status: prov('pending|confirmed|cancelled — resolved single-use, atomically'),
    expiresAt: prov('expiry wall'),
    ...stamped,
  },
}

// Every drizzle table exported by db/schema.ts, keyed by its export name. Discovered rather than
// listed, so the drift test below sees a NEW table the moment it is added — a hand-written list
// would silently stay complete.
export const TABLES: Record<string, Table> = {}
for (const [name, value] of Object.entries(schema)) {
  // `is` is drizzle's runtime brand check; the cast only widens the specific PgTableWithColumns
  // literal type to the generic Table we read columns off.
  if (is(value, Table)) TABLES[name] = value as Table
}

export const classOf = (table: string, column: string): ColumnClass | undefined => POLICY[table]?.[column]?.cls

// The columns a read-only surface may SELECT: everything that is not a secret. Secrets are excluded
// here rather than at the render site, so no view can leak one by forgetting.
export function displayableColumns(table: string): string[] {
  const t = POLICY[table]
  if (!t) return []
  return Object.entries(t)
    .filter(([, p]) => p.cls !== 'secret')
    .map(([c]) => c)
}

// The future edit allowlist (Phase 3). Derived from the policy, enforced SERVER-SIDE and
// independently of any form, so a hand-crafted POST cannot widen the write set.
export const editableColumns = (table: string): string[] =>
  Object.entries(POLICY[table] ?? {})
    .filter(([, p]) => p.cls === 'open')
    .map(([c]) => c)

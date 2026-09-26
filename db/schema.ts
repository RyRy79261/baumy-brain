import {
  pgTable,
  text,
  boolean,
  integer,
  smallint,
  bigint,
  uuid,
  jsonb,
  real,
  numeric,
  timestamp,
  interval,
  vector,
  index,
  uniqueIndex,
  check,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Postgres full-text search vector (drizzle has no native tsvector type). Used as
// a STORED generated column so Postgres maintains the lexical index from content
// automatically — the lexical half of hybrid RRF retrieval (memory Phase 2).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

// Baumy Brain memory-first schema (Phase 1 / task-graph S2).
// Principles: ONE shared house pool (no visibility/owner_user_id/RLS);
// free-form TEXT labels (kind/memory_type/predicate — NEVER pgEnum);
// bitemporal + soft-supersede; group_id origin-scope on every house-data table;
// HNSW indexes are hand-written in raw SQL (drizzle #5792), NOT in the builder.

// ── Registry / security ──────────────────────────────────────────

export const telegramChats = pgTable('baumy_telegram_chats', {
  chatId: text('chat_id').primaryKey(), // negative for groups; text (64-bit safe)
  kind: text('kind').notNull().default('house_group'), // 'house_group' | 'direct'
  title: text('title'),
  isPrimary: boolean('is_primary').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const members = pgTable('baumy_members', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  groupId: text('group_id')
    .notNull()
    .references(() => telegramChats.chatId),
  displayName: text('display_name'),
  role: text('role').notNull().default('member'), // 'owner' | 'member'
  canAccessDashboard: boolean('can_access_dashboard').notNull().default(false),
  dmChatId: text('dm_chat_id'), // captured on /start (dashboard members only)
  isActive: boolean('is_active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Idempotency ledger (dedup on update_id). The message body is NOT persisted (privacy — the
// bot sees ALL group msgs, incl. secrets); `raw` is intentionally left null.
export const telegramUpdates = pgTable('baumy_telegram_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  chatId: text('chat_id'),
  status: text('status').notNull().default('received'), // 'received'|'processed'|'dead_letter'
  raw: jsonb('raw'), // intentionally left NULL — the message body is NOT persisted here (privacy: it can contain a secret and nothing reads it); this row exists only for update_id dedup

  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

// The 48h CONVERSATION WINDOW (docs/spec/chat-understanding-v2.md §5, D1; lib/turn/window.ts). Every
// inbound house/DM message (after lane resolution) and every Baumy send, so a follow-up ("which room is
// she in?") can be read against the last few turns. Privacy rule (replaces "never persist the body"):
// a SECRET is never persisted — `text_redacted` is the text with any scanSensitivity hit withheld
// behind its descriptor — and nothing outlives 48h (hourly purge; reads also filter by 48h). Context
// only: it never writes a fact and is never shown to anyone.
export const messages = pgTable(
  'baumy_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The house SCOPE (houseScopeForOrigin) — a DM row carries the house scope too; reads also key
    // on chat_id, so a DM never shows up in the group's window (or another member's DM).
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    chatId: text('chat_id').notNull(), // transport chat (house group / the member's own DM)
    messageId: text('message_id').notNull(),
    // 'member' (a housemate, author_member_id set) | 'baumy' (one of Baumy's own sends) | 'anon' (an
    // anonymous-admin post — house text with no attributable author, I8).
    authorKind: text('author_kind').notNull().default('member'),
    authorMemberId: text('author_member_id').references(() => members.telegramUserId, {
      onDelete: 'set null',
    }),
    authorName: text('author_name'), // display name at write time ('Baumy' for its own sends)
    textRedacted: text('text_redacted').notNull(),
    // The lane's trust ('trusted' DM / 'untrusted' group), 'forwarded' for a member-forwarded message
    // (labelled, never someone's own words), 'system' for Baumy. Bot-origin posts are never stored.
    trust: text('trust').notNull().default('untrusted'),
    replyToMessageId: text('reply_to_message_id'),
    threadId: bigint('thread_id', { mode: 'number' }), // forum topic (null = General / not a forum / DM)
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    // What this message PRODUCED (the evidence note, facts, reminders) — the map an edit (I1, phase 5)
    // needs to supersede them. Plain ids, no FK: the window row is purged long before they are.
    producedMemoryItemId: uuid('produced_memory_item_id'),
    producedFactIds: jsonb('produced_fact_ids').$type<string[]>().notNull().default([]),
    producedReminderIds: jsonb('produced_reminder_ids').$type<string[]>().notNull().default([]),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // Insert order — the tie-break when a reply shares its message's sent_at (a turn runs at one
    // instant under the sandbox clock), so "newest last" is deterministic.
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    index('baumy_messages_group_idx').on(t.groupId, t.sentAt),
    // An edit arrives as the same (chat, message_id): it updates the row instead of duplicating it.
    uniqueIndex('baumy_messages_chat_msg_uq').on(t.chatId, t.messageId),
    index('baumy_messages_chat_sent_idx').on(t.chatId, t.sentAt),
  ],
)

// Send-claim guard (D12): insert-before-send for one-send-per-inbound.
export const replies = pgTable('baumy_replies', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
})

export const houseConfig = pgTable(
  'baumy_house_config',
  {
    id: boolean('id').primaryKey().default(true),
    // The STABLE house scope id — the key every memory/fact/reminder row is group-scoped by.
    // Captured on bot-add and NEVER rewritten on a supergroup migration (that would orphan all
    // memory). The live transport id below rides the migration instead (docs/spec/telegram.md D9).
    houseGroupChatId: text('house_group_chat_id'),
    // The CURRENT Telegram transport id (a -100… supergroup id after a group→supergroup upgrade).
    // Null → the group hasn't migrated, so sends/inbound use house_group_chat_id. This is the
    // "alias" seam: scope stays put (house_group_chat_id), transport follows the migration here.
    liveChatId: text('live_chat_id'),
    // Provenance: the id we migrated away from (audit/debug only). Additive, nullable.
    migratedFromChatId: text('migrated_from_chat_id'),
    // The forum-topic thread that proactive reminders / event heads-ups post into (the "notification
    // channel"). Null → the group isn't a forum, or reminders go to the General topic. Captured by
    // the owner running /notifyhere INSIDE the target topic (Telegram has no list-topics API), so the
    // value is a Telegram-authenticated message_thread_id, never message text. docs/spec/telegram.md.
    reminderThreadId: bigint('reminder_thread_id', { mode: 'number' }),
    // The forum topic dedicated to TALKING TO Baumy (the "ask-Baumy"/concierge channel). In this
    // topic Baumy is fully conversational (answers without an @mention) and read-only introspection
    // commands are handy. Null → no such topic. It changes VERBOSITY, never trust: messages there are
    // still untrusted house text, so nothing privileged rides on it. Set by the owner's /baumyhere.
    consoleThreadId: bigint('console_thread_id', { mode: 'number' }),
    houseTimezone: text('house_timezone').notNull().default('Europe/Berlin'),
    responsePolicy: jsonb('response_policy')
      .notNull()
      .default(
        sql`'{"global_enabled":true,"categories":{"scheduling":true,"info_lookup":true},"confidence_threshold":0.7,"muted_topics":[]}'::jsonb`,
      ),
    dailySpendCapUsd: numeric('daily_spend_cap_usd').notNull().default('0.50'),
    secureKeyVersion: smallint('secure_key_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('baumy_house_config_singleton', sql`${t.id}`)],
)

export const auditLog = pgTable('baumy_audit_log', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  action: text('action').notNull(),
  actorMemberId: text('actor_member_id'),
  target: text('target'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Memory substrate ─────────────────────────────────────────────

export const entities = pgTable('baumy_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: text('group_id')
    .notNull()
    .references(() => telegramChats.chatId),
  kind: text('kind').notNull(), // free-form label (NEVER pgEnum)
  canonicalName: text('canonical_name').notNull(),
  aliases: text('aliases').array(),
  // Bridge to the roster (memory v2 §1): a person-entity that IS a housemate links to
  // its member row. Housemates ⊆ people; members stays the auth source of truth.
  memberId: text('member_id').references(() => members.telegramUserId, { onDelete: 'set null' }),
  nameEmbedding: vector('name_embedding', { dimensions: 512 }), // HNSW index in raw SQL migration
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const memoryItems = pgTable('baumy_memory_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: text('group_id')
    .notNull()
    .references(() => telegramChats.chatId),
  sourceKind: text('source_kind').notNull(), // 'message' | 'fact'
  sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
  memoryType: text('memory_type').notNull(), // free-form label
  content: text('content').notNull(),
  authoredBy: text('authored_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
  // The person this note/observation is ABOUT (memory v2 §3) — sentiment/notes gather
  // under a person for their profile + reflection. NULL for general memory. Attributed
  // (authoredBy) + qualitative (content), NEVER a score.
  aboutEntityId: uuid('about_entity_id').references(() => entities.id, { onDelete: 'set null' }),
  trustLevel: text('trust_level').notNull().default('untrusted'), // 'trusted'|'untrusted'|'forwarded'|'quarantined'|'system'
  // A member-FORWARDED message (trust 'forwarded', docs/spec/chat-understanding-v2.md D4): the housemate
  // who forwarded it. Never `authored_by` — the words are someone else's (the landlord's, the council's);
  // grounding labels the note "forwarded by X". NULL for everything else.
  forwardedBy: text('forwarded_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
  isSecure: boolean('is_secure').notNull().default(false),
  contentEncrypted: text('content_encrypted'), // AES-256-GCM base64(iv||tag||ct) when is_secure; plaintext content holds only a descriptor
  salience: real('salience').notNull().default(0.5),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Lexical index for hybrid RRF recall (memory Phase 2) — generated + STORED so
  // Postgres keeps it in sync with content; queried via a GIN index (below).
  contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector('english', "content")`),
}, (t) => [index('baumy_memory_items_tsv_idx').using('gin', t.contentTsv)])

// Embeddings split 1:N by model → sync-write item, embed later; zero-downtime re-embed.
export const memoryEmbeddings = pgTable(
  'baumy_memory_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryItemId: uuid('memory_item_id')
      .notNull()
      .references(() => memoryItems.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: 512 }).notNull(),
  },
  (t) => [uniqueIndex('baumy_memory_embeddings_item_model_uq').on(t.memoryItemId, t.model)],
)

// Unified facts + edges (object_entity_id set ⇒ edge; object_value/json ⇒ attribute).
export const facts = pgTable(
  'baumy_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    subjectEntityId: uuid('subject_entity_id').references(() => entities.id, { onDelete: 'set null' }),
    predicate: text('predicate').notNull(), // free-form label
    objectEntityId: uuid('object_entity_id').references(() => entities.id, { onDelete: 'set null' }),
    objectValue: text('object_value'), // attribute plaintext (NULL when is_secure)
    objectJson: jsonb('object_json'),
    authoredBy: text('authored_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
    trustLevel: text('trust_level').notNull().default('untrusted'),
    // secure-value (app-side AES-256-GCM; base64 text — a DB dump is useless without BAUMY_ENCRYPTION_KEY)
    isSecure: boolean('is_secure').notNull().default(false),
    valueCiphertext: text('value_ciphertext'),
    valueIv: text('value_iv'), // reserved / not yet written — the IV is packed inside value_ciphertext (base64 iv||tag||ct), so this stays NULL
    keyVersion: smallint('key_version'),
    // dated events + recurrence
    eventAt: timestamp('event_at', { withTimezone: true }),
    recurrence: text('recurrence'), // RRULE-lite ('FREQ=YEARLY') or NULL
    // bitemporal + soft-supersede
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => facts.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // provenance + lineage (docs/spec/fact-lineage.md): the evidence note a fact was extracted
    // from (its ORIGIN — paired with authored_by = who), and the prior fact this one follows
    // from (its PARENT — a supersession target, or the previous thing recorded about the same
    // subject). Together with authored_by these build a per-entity timeline, sourced across
    // people ("you said Zosia's coming" → "Marco said she arrived"). Both nullable.
    sourceMemoryItemId: uuid('source_memory_item_id').references(() => memoryItems.id, { onDelete: 'set null' }),
    derivedFromFactId: uuid('derived_from_fact_id').references((): AnyPgColumn => facts.id, { onDelete: 'set null' }),
    // A correction the trust gate refused (docs/spec/chat-understanding-v2.md §7, F5): kept NOT current,
    // pointing at the live fact it contradicts, so the turn can ask which is right. NULL for every
    // ordinary fact. The nightly hygiene sweep retires it once the incumbent is no longer live.
    conflictsWithFactId: uuid('conflicts_with_fact_id').references((): AnyPgColumn => facts.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('baumy_facts_group_current_idx').on(t.groupId, t.isCurrent),
    index('baumy_facts_subject_idx').on(t.subjectEntityId), // per-entity timeline walks
    index('baumy_facts_derived_idx').on(t.derivedFromFactId), // lineage-tree walks
  ],
)

// ── Structured features ──────────────────────────────────────────

export const reminders = pgTable(
  'baumy_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    deliverChatId: text('deliver_chat_id').notNull(), // = house group, resolved in code (never LLM)
    content: text('content').notNull(),
    anchorKind: text('anchor_kind').notNull(), // 'absolute'|'relative'|'event_offset'
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    eventFactId: uuid('event_fact_id').references(() => facts.id, { onDelete: 'cascade' }),
    leadInterval: interval('lead_interval'), // 'a week before'
    recurrence: text('recurrence'), // RRULE-lite (lib/reminders/recurrence.ts) or NULL for a one-off
    // The occurrence this row follows in a recurring series. UNIQUE: scheduling the next occurrence is
    // an INSERT … ON CONFLICT DO NOTHING on this column, so a retried / repeated "create next" can
    // never schedule a series twice (exactly-once, docs/spec/chat-understanding-v2.md §6).
    previousReminderId: uuid('previous_reminder_id').references((): AnyPgColumn => reminders.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('scheduled'), // scheduled|firing|sent|cancelled|failed
    createdBy: text('created_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('baumy_reminders_due_idx').on(t.status, t.fireAt), uniqueIndex('baumy_reminders_previous_uq').on(t.previousReminderId)],
)

// User-definable recurring queries; digests are a built-in (is_system) instance.
export const scheduledTasks = pgTable(
  'baumy_scheduled_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    prompt: text('prompt').notNull(),
    cadence: text('cadence').notNull(), // cron/interval; run by the shared scheduled-task-dispatch cron
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    untilExpiry: timestamp('until_expiry', { withTimezone: true }),
    untilCondition: text('until_condition'),
    requesterMemberId: text('requester_member_id').references(() => members.telegramUserId, {
      onDelete: 'set null',
    }),
    modelTier: text('model_tier').notNull().default('assess'), // 'assess' | 'advisor'
    webSearchEnabled: boolean('web_search_enabled').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('baumy_scheduled_tasks_active_idx').on(t.isActive, t.nextRunAt)],
)

// First-class house shopping list (docs/spec/shopping-list.md). Crosses the memory-core
// "graduation rule" (memory-core.md #10): a shopping list needs current-state + uniqueness +
// mutation (add / check off / query), which fuzzy fact-memory can't give — so it earns a real
// table. Group-scoped like every house-data table; a member DM writes THROUGH to the house list
// (scope = houseScopeForOrigin, never the inbound chat). `list_name` is a resilience seam — one
// 'shopping' list today; a 'todo'/'guests' list later needs no migration. Auto-commit tier (like
// reminders/capture): the LLM proposes items, deterministic code disposes; NOT confirm-gated.
export const listItems = pgTable(
  'baumy_list_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    listName: text('list_name').notNull().default('shopping'), // resilience seam (one list today)
    item: text('item').notNull(), // display text, verbatim ("oat milk")
    itemNormalized: text('item_normalized').notNull(), // lower(trim) dedupe key — precision-first, code-computed
    addedBy: text('added_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
    checkedBy: text('checked_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }), // null = still open (unbought)
    isActive: boolean('is_active').notNull().default(true), // soft-remove (never hard delete)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('baumy_list_items_group_open_idx').on(t.groupId, t.isActive),
    // ONE open copy of an item per house list — a re-add while it's already open is a no-op;
    // checking it off (checked_at set) drops it out of the predicate, so a later re-add is allowed.
    uniqueIndex('baumy_list_items_open_uq')
      .on(t.groupId, t.listName, t.itemNormalized)
      .where(sql`${t.isActive} AND ${t.checkedAt} IS NULL`),
  ],
)

// ── Operability ──────────────────────────────────────────────────

// reserved / not yet written — prompt registry for future prompt versioning; nothing writes it yet.
export const prompts = pgTable(
  'baumy_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    model: text('model'),
    params: jsonb('params'),
    label: text('label'), // 'production' | 'staging'
    contentHash: text('content_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('baumy_prompts_name_version_uq').on(t.name, t.version)],
)

// Spend ledger for the hard daily cap (reminder delivery is never gated).
// reserved / not yet written — usage metering isn't recording yet (see settings page), so no path inserts rows.
export const llmUsage = pgTable('baumy_llm_usage', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costNanoUsd: bigint('cost_nano_usd', { mode: 'number' }).notNull().default(0),
  updateId: bigint('update_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Dashboard magic-link login tokens (Phase 6): single-use, short-TTL, hashed at rest.
export const dashboardLoginTokens = pgTable('baumy_dashboard_login_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').notNull(), // telegram_user_id
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Privileged/sensitive actions awaiting a human tap-to-confirm (security B4).
// A member/owner proposes; only an inline-keyboard callback_query from an active
// member's authenticated from.id executes it. The tap IS the injection wall —
// group text can propose but can never self-execute a privileged action.
export const pendingActions = pgTable('baumy_pending_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: text('group_id').notNull(),
  actionType: text('action_type').notNull(), // 'reminder.create' | 'response_policy.update' | ...
  payload: jsonb('payload').notNull(),
  requestedBy: text('requested_by'), // telegram_user_id who proposed
  status: text('status').notNull().default('pending'), // pending|confirmed|cancelled
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

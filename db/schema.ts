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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

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

// Idempotency ledger; raw is nulled after processing (privacy — bot sees ALL group msgs).
export const telegramUpdates = pgTable('baumy_telegram_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  chatId: text('chat_id'),
  status: text('status').notNull().default('received'), // 'received'|'processed'|'dead_letter'
  raw: jsonb('raw'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

// Verbatim transcript — the evidence/quote layer + bot-queryable store (D17).
export const messages = pgTable(
  'baumy_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => telegramChats.chatId),
    chatId: text('chat_id').notNull(),
    messageId: text('message_id').notNull(),
    authorMemberId: text('author_member_id').references(() => members.telegramUserId, {
      onDelete: 'set null',
    }),
    text: text('text'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('baumy_messages_group_idx').on(t.groupId, t.sentAt)],
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
    houseGroupChatId: text('house_group_chat_id'),
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
  nameEmbedding: vector('name_embedding', { dimensions: 1536 }), // HNSW index in raw SQL migration
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
  trustLevel: text('trust_level').notNull().default('untrusted'), // 'trusted'|'untrusted'|'quarantined'|'system'
  isSecure: boolean('is_secure').notNull().default(false),
  contentEncrypted: text('content_encrypted'), // AES-256-GCM base64(iv||tag||ct) when is_secure; plaintext content holds only a descriptor
  salience: real('salience').notNull().default(0.5),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Embeddings split 1:N by model → sync-write item, embed later; zero-downtime re-embed.
export const memoryEmbeddings = pgTable(
  'baumy_memory_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryItemId: uuid('memory_item_id')
      .notNull()
      .references(() => memoryItems.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
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
    valueIv: text('value_iv'),
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
  },
  (t) => [index('baumy_facts_group_current_idx').on(t.groupId, t.isCurrent)],
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
    recurrence: text('recurrence'),
    status: text('status').notNull().default('scheduled'), // scheduled|firing|sent|cancelled|failed
    createdBy: text('created_by').references(() => members.telegramUserId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('baumy_reminders_due_idx').on(t.status, t.fireAt)],
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

// ── Operability ──────────────────────────────────────────────────

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

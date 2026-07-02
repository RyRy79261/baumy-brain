import { pgTable, bigint, text, timestamp, jsonb } from 'drizzle-orm/pg-core'

// Phase 0 starter: the idempotency/dedup anchor + verbatim ingest log
// (architecture D7). The full memory substrate (memory_items, entities,
// facts, reminders, scheduled_tasks, members, house_config, ...) lands in
// Phase 1 (task-graph S2) — this keeps the dual-driver client type-safe now.
export const inboundMessages = pgTable('baumy_inbound_messages', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  chatId: text('chat_id').notNull(),
  fromId: bigint('from_id', { mode: 'number' }),
  text: text('text'),
  raw: jsonb('raw'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
})

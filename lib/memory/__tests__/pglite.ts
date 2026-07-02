import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/db/schema'
import type { Database } from '@/db/client'

// Deterministic keyword-based fake embedding (1536-dim, normalized). Cosine
// similarity ≈ word overlap — enough to prove store-then-recall without a model.
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(1536).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) % 1536
    v[h] = 1
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

// Just the tables the memory helpers touch (no HNSW needed for correctness).
const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE baumy_telegram_chats (chat_id text PRIMARY KEY, kind text NOT NULL DEFAULT 'house_group', title text, is_primary boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_members (telegram_user_id text PRIMARY KEY, group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), display_name text, role text NOT NULL DEFAULT 'member', can_access_dashboard boolean NOT NULL DEFAULT false, dm_chat_id text, is_active boolean NOT NULL DEFAULT true, deactivated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_memory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), source_kind text NOT NULL, source_message_id uuid, memory_type text NOT NULL, content text NOT NULL, authored_by text REFERENCES baumy_members(telegram_user_id), trust_level text NOT NULL DEFAULT 'untrusted', is_secure boolean NOT NULL DEFAULT false, content_encrypted text, salience real NOT NULL DEFAULT 0.5, access_count integer NOT NULL DEFAULT 0, last_accessed_at timestamptz, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_memory_embeddings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), memory_item_id uuid NOT NULL REFERENCES baumy_memory_items(id) ON DELETE CASCADE, model text NOT NULL, embedding vector(1536) NOT NULL);
CREATE TABLE baumy_facts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), predicate text NOT NULL DEFAULT '', is_current boolean NOT NULL DEFAULT true, recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), deliver_chat_id text NOT NULL, content text NOT NULL, anchor_kind text NOT NULL DEFAULT 'absolute', fire_at timestamptz NOT NULL, event_fact_id uuid REFERENCES baumy_facts(id) ON DELETE CASCADE, lead_interval interval, recurrence text, status text NOT NULL DEFAULT 'scheduled', created_by text REFERENCES baumy_members(telegram_user_id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_scheduled_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), prompt text NOT NULL, cadence text NOT NULL, next_run_at timestamptz, last_run_at timestamptz, until_expiry timestamptz, until_condition text, requester_member_id text REFERENCES baumy_members(telegram_user_id) ON DELETE SET NULL, model_tier text NOT NULL DEFAULT 'assess', web_search_enabled boolean NOT NULL DEFAULT false, is_system boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_dashboard_login_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE, user_id text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_pending_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL, action_type text NOT NULL, payload jsonb NOT NULL, requested_by text, status text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_house_config (id boolean PRIMARY KEY DEFAULT true, house_group_chat_id text, house_timezone text NOT NULL DEFAULT 'Europe/Berlin', response_policy jsonb NOT NULL DEFAULT '{"global_enabled":true,"categories":{},"confidence_threshold":0.7,"muted_topics":[]}'::jsonb, daily_spend_cap_usd numeric NOT NULL DEFAULT '0.50', secure_key_version smallint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL, actor_member_id text, target text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
`

export async function makeTestDb(): Promise<Database> {
  const client = new PGlite({ extensions: { vector } })
  await client.exec(DDL)
  return drizzle(client, { schema }) as unknown as Database
}

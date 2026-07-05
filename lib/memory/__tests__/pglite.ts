import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/db/schema'
import type { Database } from '@/db/client'
import { embedSync } from '@/lib/ai/embed'

// Tests exercise the REAL production embedder (local, deterministic) rather than
// a stand-in, so store-then-recall is verified against actual behavior.
export function fakeEmbed(text: string): number[] {
  return embedSync(text)
}

// Just the tables the memory helpers touch (no HNSW needed for correctness).
const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE baumy_telegram_chats (chat_id text PRIMARY KEY, kind text NOT NULL DEFAULT 'house_group', title text, is_primary boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_members (telegram_user_id text PRIMARY KEY, group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), display_name text, role text NOT NULL DEFAULT 'member', can_access_dashboard boolean NOT NULL DEFAULT false, dm_chat_id text, is_active boolean NOT NULL DEFAULT true, deactivated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_memory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), source_kind text NOT NULL, source_message_id uuid, memory_type text NOT NULL, content text NOT NULL, authored_by text REFERENCES baumy_members(telegram_user_id), about_entity_id uuid, trust_level text NOT NULL DEFAULT 'untrusted', is_secure boolean NOT NULL DEFAULT false, content_encrypted text, salience real NOT NULL DEFAULT 0.5, access_count integer NOT NULL DEFAULT 0, last_accessed_at timestamptz, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED);
CREATE INDEX baumy_memory_items_tsv_idx ON baumy_memory_items USING gin (content_tsv);
CREATE TABLE baumy_memory_embeddings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), memory_item_id uuid NOT NULL REFERENCES baumy_memory_items(id) ON DELETE CASCADE, model text NOT NULL, embedding vector(512) NOT NULL);
CREATE TABLE baumy_entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), kind text NOT NULL, canonical_name text NOT NULL, aliases text[], member_id text REFERENCES baumy_members(telegram_user_id), name_embedding vector(512), is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_facts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), subject_entity_id uuid REFERENCES baumy_entities(id), predicate text NOT NULL DEFAULT '', object_entity_id uuid REFERENCES baumy_entities(id), object_value text, object_json jsonb, authored_by text REFERENCES baumy_members(telegram_user_id), trust_level text NOT NULL DEFAULT 'untrusted', is_secure boolean NOT NULL DEFAULT false, value_ciphertext text, value_iv text, key_version smallint, event_at timestamptz, recurrence text, valid_from timestamptz, valid_to timestamptz, is_current boolean NOT NULL DEFAULT true, superseded_by uuid REFERENCES baumy_facts(id), recorded_at timestamptz NOT NULL DEFAULT now(), invalidated_at timestamptz, deleted_at timestamptz, source_memory_item_id uuid REFERENCES baumy_memory_items(id), derived_from_fact_id uuid REFERENCES baumy_facts(id));
CREATE TABLE baumy_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), deliver_chat_id text NOT NULL, content text NOT NULL, anchor_kind text NOT NULL DEFAULT 'absolute', fire_at timestamptz NOT NULL, event_fact_id uuid REFERENCES baumy_facts(id) ON DELETE CASCADE, lead_interval interval, recurrence text, status text NOT NULL DEFAULT 'scheduled', created_by text REFERENCES baumy_members(telegram_user_id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_scheduled_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), prompt text NOT NULL, cadence text NOT NULL, next_run_at timestamptz, last_run_at timestamptz, until_expiry timestamptz, until_condition text, requester_member_id text REFERENCES baumy_members(telegram_user_id) ON DELETE SET NULL, model_tier text NOT NULL DEFAULT 'assess', web_search_enabled boolean NOT NULL DEFAULT false, is_system boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_dashboard_login_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE, user_id text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_pending_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL, action_type text NOT NULL, payload jsonb NOT NULL, requested_by text, status text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_house_config (id boolean PRIMARY KEY DEFAULT true, house_group_chat_id text, house_timezone text NOT NULL DEFAULT 'Europe/Berlin', response_policy jsonb NOT NULL DEFAULT '{"global_enabled":true,"categories":{},"confidence_threshold":0.7,"muted_topics":[]}'::jsonb, daily_spend_cap_usd numeric NOT NULL DEFAULT '0.50', secure_key_version smallint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL, actor_member_id text, target text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
`

export async function makeTestDb(): Promise<Database> {
  const client = new PGlite({ extensions: { vector, pg_trgm } })
  await client.exec(DDL)
  return drizzle(client, { schema }) as unknown as Database
}

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
CREATE TABLE baumy_memory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES baumy_telegram_chats(chat_id), source_kind text NOT NULL, source_message_id uuid, memory_type text NOT NULL, content text NOT NULL, authored_by text REFERENCES baumy_members(telegram_user_id), trust_level text NOT NULL DEFAULT 'untrusted', salience real NOT NULL DEFAULT 0.5, access_count integer NOT NULL DEFAULT 0, last_accessed_at timestamptz, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE baumy_memory_embeddings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), memory_item_id uuid NOT NULL REFERENCES baumy_memory_items(id) ON DELETE CASCADE, model text NOT NULL, embedding vector(1536) NOT NULL);
`

export async function makeTestDb(): Promise<Database> {
  const client = new PGlite({ extensions: { vector } })
  await client.exec(DDL)
  return drizzle(client, { schema }) as unknown as Database
}

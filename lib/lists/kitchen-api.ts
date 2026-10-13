import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { createHttpDb, type Database } from '@/db/client'
import { members } from '@/db/schema'
import { getHouseChatId } from '@/lib/identity/house'
import { ensureRegistered } from '@/lib/memory/write'
import { tokenMatches } from '@/lib/telegram/verify'
import { addListItems, checkOffItems, currentList, removeItems, renameItem, setItemCategory, type ListRow } from '@/lib/lists/store'
import { noteShoppingChange } from '@/lib/lists/board'
import { requestCategorize } from '@/lib/lists/categorize'
import { CATEGORIES } from '@/lib/lists/categories'

// The kitchen shopping API (docs/spec/shopping-list.md §Kitchen API): the house kiosk (Baumy
// Olympics) reads and writes the SAME group-scoped list Telegram does, so there is one list.
//
// Walls, in order — every one fails closed:
//   1. Bearer KITCHEN_API_TOKEN, compared in constant time (tokenMatches, as the webhook does).
//      An unset token authorizes nobody.
//   2. The SCOPE is getHouseChatId(db) — the stable memory scope, honouring the
//      BAUMY_HOUSE_CHAT_ID pin; never the send id and NEVER anything in the request. '' (the bot is
//      not in a group yet) → 503 not_configured, before any read or write.
//   3. Attribution: added_by / checked_by is null, or an ACTIVE member when the caller supplies a
//      telegramUserId that maps to one. An unknown id is never written (it would be a spoofable,
//      unauthenticated name — and a dangling FK): it is attributed to nobody.
// The store (lib/lists/store.ts) is the dispose layer, unchanged: exact-normalized dedupe backed by
// the partial-unique index, so re-adding an open item is a no-op.

export const KITCHEN_TOKEN_ENV = 'KITCHEN_API_TOKEN'

/** Read `Authorization: Bearer <token>` and compare it to KITCHEN_API_TOKEN in constant time. */
export function verifyKitchenToken(req: Request): boolean {
  const expected = process.env[KITCHEN_TOKEN_ENV] ?? ''
  if (!expected) {
    console.warn(`[baumy/kitchen] ${KITCHEN_TOKEN_ENV} is not set — the kitchen API refuses every request`)
    return false
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')
  return tokenMatches(m?.[1] ?? '', expected)
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Run a kitchen handler behind the token + house-scope walls. `fn` receives the db and the house
 * SCOPE id; it is only called when both walls pass.
 */
export async function withKitchenHouse(req: Request, fn: (db: Database, scope: string) => Promise<Response>): Promise<Response> {
  if (!verifyKitchenToken(req)) return json({ ok: false, error: 'unauthorized' }, 401)
  const db = createHttpDb()
  const scope = await getHouseChatId(db)
  if (!scope) return json({ ok: false, error: 'not_configured', message: 'Baumy has not been added to the house group yet.' }, 503)
  return fn(db, scope)
}

// A kiosk write. `items` goes through the store's own clamps (blank drop, 80-char clamp, 30-item
// cap); this schema only rejects what is plainly not a list write. telegramUserId is optional.
const WriteBody = z.object({
  items: z.array(z.string().max(200)).min(1).max(30),
  telegramUserId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).optional(),
})
type WriteBody = z.infer<typeof WriteBody>

// A kiosk rename (issue #23): ONE item, what it reads now → what it should read.
const RenameBody = z.object({
  from: z.string().trim().min(1).max(200),
  to: z.string().trim().min(1).max(200),
  telegramUserId: WriteBody.shape.telegramUserId,
})
type RenameBody = z.infer<typeof RenameBody>

async function parseBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | null> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return null
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
const parseWrite = (req: Request) => parseBody<WriteBody>(req, WriteBody)
const BAD_WRITE = { ok: false, error: 'bad_request', message: 'Expected { items: string[1..30], telegramUserId? }.' }

// v1 is one house (the members PK is global — see houseScopeForOrigin's MULTI-HOUSE SEAM), so a
// mapped member is simply an ACTIVE roster row, the same rule loadRoster applies. Anything else → null.
export async function mapMember(db: Database, telegramUserId: string | number | undefined): Promise<string | null> {
  if (telegramUserId === undefined) return null
  const id = String(telegramUserId)
  const [m] = await db
    .select({ id: members.telegramUserId })
    .from(members)
    .where(and(eq(members.telegramUserId, id), eq(members.isActive, true)))
    .limit(1)
  return m?.id ?? null
}

// The item shape every response carries. `category` (issue #29) is one of the six keys
// (lib/lists/categories.ts) or null = "Not sorted" — null too while auto-sorting has not run yet.
const view = (rows: ListRow[]) =>
  rows.map((r) => ({ id: r.id, item: r.item, addedBy: r.addedBy, createdAt: r.createdAt.toISOString(), category: r.category }))

export async function handleList(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => json({ ok: true, items: view(await currentList(db, scope)) }))
}

export async function handleAdd(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    const body = await parseWrite(req)
    if (!body) return json(BAD_WRITE, 400)
    const by = await mapMember(db, body.telegramUserId)
    // The list row FKs the house chat. Registering it is idempotent — the same call the Telegram
    // lane makes — and matters when the scope is the BAUMY_HOUSE_CHAT_ID pin.
    await ensureRegistered(db, scope, null)
    const res = await addListItems(db, { groupId: scope, items: body.items, addedBy: by })
    // The list changed → stamp it and ask for the debounced live-list edit (best-effort; never fails the write).
    if (res.added.length > 0) await noteShoppingChange(db, scope, by)
    // Sort the new items AFTER the add (issue #29): best-effort, never fails or delays the write — they
    // come back as category null ("Not sorted") here and gain a category within seconds.
    await requestCategorize(scope, res.addedIds)
    return json({ ok: true, added: res.added, already: res.already, attributedTo: by, items: view(await currentList(db, scope)) })
  })
}

export async function handleCheckOff(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    const body = await parseWrite(req)
    if (!body) return json(BAD_WRITE, 400)
    const by = await mapMember(db, body.telegramUserId)
    const res = await checkOffItems(db, { groupId: scope, items: body.items, checkedBy: by })
    if (res.checkedOff.length > 0) await noteShoppingChange(db, scope, by)
    return json({ ok: true, checkedOff: res.checkedOff, notFound: res.notFound, attributedTo: by, items: view(await currentList(db, scope)) })
  })
}

// Remove items WITHOUT buying them (issue #23): soft (is_active=false), never a bought record.
export async function handleRemove(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    const body = await parseWrite(req)
    if (!body) return json(BAD_WRITE, 400)
    const by = await mapMember(db, body.telegramUserId)
    const res = await removeItems(db, { groupId: scope, items: body.items, removedBy: by })
    if (res.removed.length > 0) await noteShoppingChange(db, scope, by)
    return json({ ok: true, removed: res.removed, notFound: res.notFound, ambiguous: res.ambiguous, attributedTo: by, items: view(await currentList(db, scope)) })
  })
}

// Rename ONE open item (issue #23). `outcome`: renamed | merged (the new name was already open, so the
// old row was removed) | unchanged | not_found (no open item matches `from`) | ambiguous (more than one
// does — `matches` names them).
export async function handleRename(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    const body = await parseBody<RenameBody>(req, RenameBody)
    if (!body) return json({ ok: false, error: 'bad_request', message: 'Expected { from: string, to: string, telegramUserId? }.' }, 400)
    const by = await mapMember(db, body.telegramUserId)
    const res = await renameItem(db, { groupId: scope, from: body.from, to: body.to, renamedBy: by })
    if (res.outcome === 'renamed' || res.outcome === 'merged') await noteShoppingChange(db, scope, by)
    return json({
      ok: true,
      outcome: res.outcome,
      from: res.from,
      to: res.to,
      ...(res.outcome === 'ambiguous' ? { matches: res.matches ?? [] } : {}),
      attributedTo: by,
      items: view(await currentList(db, scope)),
    })
  })
}

// A kiosk category pick (issue #29): `{ id?: uuid, item?: string, category: key | null, telegramUserId? }`.
// One of id / item is required; with both, `id` is used. `category` is one of the six keys or null
// ("Not sorted"); anything else is a 400. The pick is source `picked` and teaches the house memory.
const CategoryBody = z
  .object({
    id: z.string().uuid().optional(),
    item: z.string().trim().min(1).max(200).optional(),
    category: z.enum(CATEGORIES).nullable(),
    telegramUserId: WriteBody.shape.telegramUserId,
  })
  .refine((b) => b.id != null || b.item != null)
type CategoryBody = z.infer<typeof CategoryBody>

// `outcome`: set | not_found (no item on the list matches) | ambiguous (the text fits more than one open
// item — `matches` names them). Like a rename, a miss is a 200 that changed nothing.
export async function handleCategory(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    const body = await parseBody<CategoryBody>(req, CategoryBody)
    if (!body)
      return json(
        { ok: false, error: 'bad_request', message: `Expected { id?: uuid, item?: string, category: ${CATEGORIES.join(' | ')} | null, telegramUserId? } with id or item.` },
        400,
      )
    const by = await mapMember(db, body.telegramUserId)
    const res = await setItemCategory(db, { groupId: scope, id: body.id, item: body.id ? undefined : body.item, category: body.category, by })
    if (res.outcome === 'set') await noteShoppingChange(db, scope, by)
    return json({
      ok: true,
      outcome: res.outcome,
      ...(res.id ? { id: res.id } : {}),
      item: res.item,
      category: res.category,
      ...(res.outcome === 'ambiguous' ? { matches: res.matches ?? [] } : {}),
      attributedTo: by,
      items: view(await currentList(db, scope)),
    })
  })
}

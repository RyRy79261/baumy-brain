import { describe } from 'vitest'
import { eq } from 'drizzle-orm'
import { messages } from '@/db/schema'
import { EMPTY_BOARD } from '@/lib/lists/board'
import { scenario, say, advance, check, expectDb, expectReaction, expectWords, type Run } from './dsl'
import { statement, request, chatter } from './shapes'
import { HOUSE } from './house'

// The shopping topic (docs/spec/shopping-list.md §Shopping topic, issue #21): a housemate points Baumy
// at a forum topic with /shoppinghere; after list changes Baumy posts the whole list there ONCE, about 2
// minutes after the last change, and deletes the previous post. The repost is Inngest's debounce, played
// by the sandbox on its own clock.

const TOPIC = 55

// Every shopping-list post (the unwindowed board send) and every delete, across the whole run.
const boards = (r: Run) => r.turns.flatMap((t) => t.entries).filter((e) => e.kind === 'message' && e.meta === 'board')
const deletes = (r: Run) => r.turns.flatMap((t) => t.entries).filter((e) => e.kind === 'delete')
const lastTurnEntries = (r: Run) => r.turns.at(-1)!.entries

const fixtures = {
  triage: (t: string) =>
    /out of/.test(t) ? statement({ worthRemembering: false, list: 'add' }) : /add coffee/.test(t) ? request({ asksBaumy: true, list: 'add' }) : chatter(),
  list: (t: string) =>
    /out of oat milk/.test(t)
      ? { op: 'add' as const, items: ['oat milk'] }
      : /out of bin bags/.test(t)
        ? { op: 'add' as const, items: ['bin bags'] }
        : /add coffee/.test(t)
          ? { op: 'add' as const, items: ['coffee'] }
          : { op: 'none' as const, items: [] },
}

describe('scenario: the shopping topic', () => {
  scenario('adds in Telegram → ONE repost in the topic 2 minutes after the last change, the old post deleted', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      // Marco (a member, not the owner) points Baumy at the "Shopping" topic.
      say('Marco', '/shoppinghere', { topic: TOPIC }),
      expectWords({
        contains: /shopping list/i,
        judge: 'Confirms the shopping list will be posted (and kept up to date) in this topic. Short; does not list any items.',
      }),
      // /shoppinghere asks for a post too: the (empty) list shows up after the debounce.
      advance({ minutes: 3 }),
      check('the empty list was posted in the topic', (r, e) => {
        const posted = lastTurnEntries(r).filter((x) => x.meta === 'board')
        e(posted).toHaveLength(1)
        e(posted[0].text).toBe(EMPTY_BOARD)
        e(posted[0].threadId).toBe(TOPIC)
        e(posted[0].chatId).toBe(r.sb.houseChatId)
      }),

      // A burst of changes from the group AND a DM (which writes through to the house list).
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      say('Ryan', 'add coffee to the list', { dm: true }),
      expectWords({ contains: /coffee/, judge: 'Confirms coffee was added to the shopping list.' }),
      advance({ minutes: 1 }),
      say('Chloe', "we're out of bin bags"),
      expectReaction('✍'),
      // 1.5 minutes after the LAST change: still waiting (the debounce restarted on each change).
      advance({ minutes: 1 }),
      check('nothing posted yet — the debounce waits for 2 minutes after the LAST change', (r, e) => {
        e(lastTurnEntries(r).filter((x) => x.meta === 'board')).toHaveLength(0)
        e(boards(r)).toHaveLength(1)
      }),
      advance({ minutes: 2 }),
      check('ONE repost with the whole list, in the topic; the previous post deleted after it', (r, e) => {
        const now = lastTurnEntries(r)
        const posted = now.filter((x) => x.meta === 'board')
        e(posted).toHaveLength(1)
        e(posted[0].text).toBe('🛒 Shopping list (3)\n• oat milk\n• coffee\n• bin bags')
        e(posted[0].threadId).toBe(TOPIC)
        const del = now.filter((x) => x.kind === 'delete')
        e(del).toHaveLength(1)
        e(del[0].meta).toBe(String(boards(r)[0].messageId)) // the first (empty) post
        e(now.indexOf(del[0])).toBeGreaterThan(now.indexOf(posted[0])) // post first, then delete
        e(deletes(r)).toHaveLength(1)
      }),
      expectDb(async (db, r) => {
        // A status board, not conversation: no post ever enters the 48h window.
        const rows = await db
          .select({ text: messages.textRedacted, kind: messages.authorKind })
          .from(messages)
          .where(eq(messages.chatId, r.sb.houseChatId))
        const baumy = rows.filter((x) => x.kind === 'baumy')
        return baumy.some((x) => /shopping list/i.test(x.text)) && !rows.some((x) => /Shopping list \(|The list is empty/.test(x.text))
      }, 'the list posts are not in the conversation window (Baumy\'s other house words are)'),
    ],
  })

  scenario('no shopping topic → list changes post nothing', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      advance({ minutes: 5 }),
      check('no list post and no delete', (r, e) => {
        e(r.events.some((x) => x.name === 'lists/shopping.changed')).toBe(true) // the change WAS signalled…
        e(boards(r)).toHaveLength(0) // …but with no topic the repost does nothing
        e(deletes(r)).toHaveLength(0)
      }),
    ],
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TRIAGE_SYSTEM } from '@/lib/ai/prompts'
import { replyAllowed, type ResponsePolicy } from '@/lib/policy'
import { prefilter } from '@/lib/pipeline/prefilter'

// AUDIT REPRO — the webhook's field mapping (what actually reaches ingest) + pure intake units.

const sent: any[] = []
vi.mock('@/lib/telegram/verify', () => ({ verifyWebhookSecret: () => true }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async (e: unknown) => void sent.push(e) } }))

const { POST } = await import('@/app/api/telegram/webhook/route')
const post = (update: unknown) => POST(new Request('http://x/api/telegram/webhook', { method: 'POST', body: JSON.stringify(update) }))

const HOUSE = -100123
const charli = { id: 701, is_bot: false, first_name: 'Charli' }

describe('AUDIT webhook mapping', () => {
  beforeEach(() => void (sent.length = 0))

  it('D17: a photo caption is forwarded as text=null (caption dropped)', async () => {
    await post({ update_id: 1, message: { message_id: 5, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: charli, photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }], caption: 'new bin schedule from the council — bins now go out tuesdays' } })
    expect(sent[0].data.text).toBeNull()
  })

  it('D17: voice notes / locations / contacts arrive with text=null', async () => {
    await post({ update_id: 2, message: { message_id: 6, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: charli, voice: { file_id: 'v', file_unique_id: 'v', duration: 4 } } })
    await post({ update_id: 3, message: { message_id: 7, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: charli, contact: { phone_number: '+49 30 123', first_name: 'Plumber Klaus' } } })
    expect(sent.map((s) => s.data.text)).toEqual([null, null])
  })

  it('D16: an edited_message is forwarded under the same event name with no "edited" marker', async () => {
    await post({ update_id: 4, edited_message: { message_id: 5, date: 0, edit_date: 1, chat: { id: HOUSE, type: 'supergroup' }, from: charli, text: 'fixed typo' } })
    expect(sent[0].name).toBe('telegram/message.received')
    expect(Object.keys(sent[0].data)).not.toContain('edited')
    expect(sent[0].id).toBe('tg:update:4') // dedup key is update_id, which differs from the original
  })

  it('A5: replying to ANY bot counts as replyToBot, and the replied-to text is never forwarded', async () => {
    await post({ update_id: 5, message: { message_id: 9, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: charli, text: 'lol same', reply_to_message: { message_id: 8, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: { id: 555, is_bot: true, first_name: 'PollBot' }, text: 'Vote now' } } })
    expect(sent[0].data.replyToBot).toBe(true)
    expect(JSON.stringify(sent[0].data)).not.toContain('Vote now')
    // a reply to a HUMAN message loses its context entirely ("what time?" in reply to Marco)
    await post({ update_id: 6, message: { message_id: 10, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: charli, text: 'what time?', reply_to_message: { message_id: 3, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: { id: 702, is_bot: false, first_name: 'Marco' }, text: 'plumber is coming thursday' } } })
    expect(JSON.stringify(sent[1].data)).not.toContain('plumber')
  })

  it('anonymous admin (from = GroupAnonymousBot) is flagged isBot → quarantined downstream', async () => {
    await post({ update_id: 7, message: { message_id: 11, date: 0, chat: { id: HOUSE, type: 'supergroup' }, from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' }, sender_chat: { id: HOUSE, type: 'supergroup', title: 'House' }, text: 'rent goes up to 650 from october' } })
    expect(sent[0].data.isBot).toBe(true)
  })
})

describe('AUDIT intake units', () => {
  it('E20: TRIAGE_SYSTEM never defines needsReply and gives confidence no meaning', () => {
    expect(TRIAGE_SYSTEM).not.toContain('needsReply')
    expect(TRIAGE_SYSTEM).toContain('- confidence: 0..1.')
  })

  it('A6: prefilter drops yes/no/ok regardless of context (it takes only text)', () => {
    for (const t of ['yes', 'no', 'ok', 'yep', 'nope', 'same', 'true']) expect(prefilter(t).keep).toBe(false)
  })

  it('muted topics are raw substring matches ("bin" mutes "cabinet", "robin")', () => {
    const p: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: ['bin'], reply_frequency: 'chatty', reminder_frequency: 'twice' }
    expect(replyAllowed(p, 0.99, 'does anyone know where the cabinet key is?')).toBe(false)
    expect(replyAllowed(p, 0.99, 'when is robin moving in?')).toBe(false)
  })

  it('reply floor compares the TRIAGE confidence (certainty of classification) against "how meaningful" thresholds', () => {
    const p: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [], reply_frequency: 'quiet', reminder_frequency: 'twice' }
    // an obvious rhetorical/banter question the classifier is very SURE about clears the "quiet" floor
    expect(replyAllowed(p, 0.95, 'who even ate my yogurt lol?')).toBe(true)
    // a genuinely useful but ambiguous-intent question is silenced
    expect(replyAllowed(p, 0.8, 'is the plumber still coming or')).toBe(false)
  })
})

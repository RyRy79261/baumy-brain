import { describe, it, expect } from 'vitest'
import { handleTelegramMessage } from '@/lib/inngest/functions/ingest'
import { hygieneSweep } from '@/lib/inngest/functions/hygiene'
import { functions } from '@/lib/inngest/functions'

// Function-level config that no handler test can see.
describe('inngest function config', () => {
  it('ingest runs one message at a time PER CHAT (F16: a correction is never superseded by the message it corrected)', () => {
    expect(handleTelegramMessage.opts.concurrency).toEqual([{ key: 'event.data.chatId', limit: 1 }])
  })
  it('the nightly hygiene sweep is registered (F12)', () => {
    expect(functions).toContain(hygieneSweep)
    expect(hygieneSweep.opts.id).toBe('memory-hygiene')
  })
})

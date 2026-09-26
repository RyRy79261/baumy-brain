import { describe, it, expect } from 'vitest'
import { messageContent } from '@/lib/telegram/content'

// The caption fold (spec §8, I4): the ONE place a Telegram message's words are read from.
describe('messageContent', () => {
  it('plain text is the text', () => {
    expect(messageContent({ text: 'hi' })).toEqual({ text: 'hi', media: null })
  })
  it('a caption becomes the text of its media', () => {
    expect(messageContent({ photo: [], caption: 'boiler code is 4821' })).toEqual({ text: 'boiler code is 4821', media: 'photo' })
    expect(messageContent({ document: {}, caption: 'the lease' })).toEqual({ text: 'the lease', media: 'document' })
  })
  it('media with no caption (or a blank one) has no text — ignored explicitly downstream', () => {
    expect(messageContent({ voice: {} })).toEqual({ text: null, media: 'voice' })
    expect(messageContent({ sticker: {}, caption: '   ' })).toEqual({ text: null, media: 'sticker' })
    expect(messageContent({ location: {} })).toEqual({ text: null, media: 'location' })
  })
})

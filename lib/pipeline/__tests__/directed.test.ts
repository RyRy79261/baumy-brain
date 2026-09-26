import { describe, it, expect } from 'vitest'
import { isDirectedAtBaumy, repliesToBaumy, stripBotMention, directedness, addressesByName, type ReplyToMessage } from '@/lib/pipeline/directed'

const U = 'baumy_bot' // the bot's real @username (from getMe)

describe('isDirectedAtBaumy', () => {
  it('true for an @mention of the real username (incl. the _bot suffix)', () => {
    expect(isDirectedAtBaumy('@baumy_bot Are you alive', false, U)).toBe(true)
    expect(isDirectedAtBaumy('hey @Baumy_Bot when do the bins go out', false, U)).toBe(true)
  })

  it('true for the short name as a word, and for a reply to the bot', () => {
    expect(isDirectedAtBaumy('hey baumy are you around?', false, U)).toBe(true)
    expect(isDirectedAtBaumy('ok thanks', true, U)).toBe(true) // reply-to-bot
  })

  it('false for undirected chatter or substrings', () => {
    expect(isDirectedAtBaumy('the bins go out friday', false, U)).toBe(false)
    expect(isDirectedAtBaumy('baumyish vibes', false, U)).toBe(false)
    expect(isDirectedAtBaumy(null, false, U)).toBe(false)
    expect(isDirectedAtBaumy('@baumy_bot hi', false, '')).toBe(false) // no username known
  })
})

describe('addressesByName — the short name only as a vocative (C10)', () => {
  it('true at the start ("Baumy, …", "hey baumy …") or closing the message ("…, baumy?", "thanks baumy")', () => {
    for (const t of ['Baumy, when is bin day', 'baumy what is for dinner', 'hey baumy are you around?', 'ok baumy, remind us', 'when are the bins out, baumy?', 'thanks baumy', 'Baumy is it bin day?']) {
      expect(addressesByName(t, U), t).toBe(true)
    }
  })
  it('false for talk ABOUT Baumy: possessives, mid-sentence mentions, third-person statements', () => {
    for (const t of ["Baumy's reminders are annoying lol", 'Marco, ask baumy, it knows', 'baumy keeps pinging me', 'Baumy is annoying', 'I told baumy about it yesterday', 'baumyish vibes']) {
      expect(addressesByName(t, U), t).toBe(false)
    }
  })
  // A bare trailing "baumy?" is as often the object of the sentence as a vocative. It is left to the
  // classifier (the undirected row, asksBaumy + the reply floor) rather than forcing an answer.
  it('false for a bare trailing "… baumy?" with no vocative punctuation', () => {
    for (const t of ['did you ask baumy?', 'is anyone else annoyed by baumy?', 'is it bin day baumy?']) {
      expect(addressesByName(t, U), t).toBe(false)
    }
  })
})

describe('directedness — why a message is for Baumy (spec §1)', () => {
  const base = { lane: 'house' as const, text: 'the bins go out friday', botUsername: U, replyToBaumy: false, inConsoleTopic: false, repliesToHuman: false }
  it('a DM is always directed', () => {
    expect(directedness({ ...base, lane: 'member_dm' })).toEqual({ value: true, why: 'dm' })
  })
  it('reply to Baumy, @mention, vocative name — in that order', () => {
    expect(directedness({ ...base, replyToBaumy: true, text: '@baumy_bot hi' })).toEqual({ value: true, why: 'reply_to_baumy' })
    expect(directedness({ ...base, text: 'hey @baumy_bot' })).toEqual({ value: true, why: 'mention' })
    expect(directedness({ ...base, text: 'baumy, bins?' })).toEqual({ value: true, why: 'name' })
  })
  it('the ask-Baumy topic is directed — except a reply to another housemate there (C6)', () => {
    expect(directedness({ ...base, inConsoleTopic: true })).toEqual({ value: true, why: 'console_topic' })
    expect(directedness({ ...base, inConsoleTopic: true, repliesToHuman: true })).toEqual({ value: false, why: null })
  })
  it('plain group text is not directed', () => {
    expect(directedness(base)).toEqual({ value: false, why: null })
    expect(directedness({ ...base, text: "Baumy's reminders are annoying lol" })).toEqual({ value: false, why: null })
  })
})

describe('repliesToBaumy (C8/C9)', () => {
  const BOT = 7001
  const reply = (over: Partial<ReplyToMessage> = {}): ReplyToMessage => ({ fromId: BOT, isBot: true, text: 'noted 🐈', isTopicRoot: false, ...over })

  it('true only when the replied-to author IS Baumy', () => {
    expect(repliesToBaumy(reply(), BOT)).toBe(true)
  })
  it('a reply to ANOTHER bot (poll bot, GroupAnonymousBot) is not to Baumy', () => {
    expect(repliesToBaumy(reply({ fromId: 5555 }), BOT)).toBe(false)
    expect(repliesToBaumy(reply({ fromId: 1087968824 }), BOT)).toBe(false)
  })
  it('the forum topic-root service message never counts, even if Baumy created the topic', () => {
    expect(repliesToBaumy(reply({ isTopicRoot: true }), BOT)).toBe(false)
  })
  it('no reply / unknown bot id → false; a legacy event (no replyToMessage field) honours replyToBot', () => {
    expect(repliesToBaumy(null, BOT)).toBe(false)
    expect(repliesToBaumy(reply(), null)).toBe(false)
    expect(repliesToBaumy(undefined, BOT, true)).toBe(true)
    expect(repliesToBaumy(undefined, BOT, false)).toBe(false)
  })
})

describe('stripBotMention (C12)', () => {
  it('removes the @mention wherever it sits, keeping the rest verbatim', () => {
    expect(stripBotMention('@baumy_bot Zosia is staying in my room this weekend', U)).toBe('Zosia is staying in my room this weekend')
    expect(stripBotMention('@Baumy_Bot, when do the bins go out?', U)).toBe('when do the bins go out?')
    expect(stripBotMention('when do the bins go out @baumy_bot?', U)).toBe('when do the bins go out?')
    expect(stripBotMention('thanks @baumy_bot', U)).toBe('thanks')
  })
  it('leaves other handles, emails-ish tokens and glued command suffixes alone', () => {
    expect(stripBotMention('@marco can you ask @baumy_botanist', U)).toBe('@marco can you ask @baumy_botanist')
    expect(stripBotMention('/bug@baumy_bot the sink', U)).toBe('/bug@baumy_bot the sink')
  })
  it('a bare mention falls back to the original (something is still there to classify)', () => {
    expect(stripBotMention('@baumy_bot', U)).toBe('@baumy_bot')
    expect(stripBotMention('hi', '')).toBe('hi')
  })
})

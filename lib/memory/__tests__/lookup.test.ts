import { describe, it, expect } from 'vitest'
import { askedAuthor, cuedPredicates, hasName, lookupText, matchEntities, wordText } from '@/lib/memory/lookup'

// How a question is matched against the graph's names (spec §7, F4/F7/F13) — pure.
describe('lookup text', () => {
  it('whole words only, apostrophes kept inside a word, curly quotes straightened', () => {
    const t = wordText('Is the bathroom tap fixed at ALL?')
    expect(hasName(t, 'al')).toBe(false)
    expect(hasName(t, 'bathroom tap')).toBe(true)
    expect(hasName(wordText('who’s in Charli’s room?'), "charli's room")).toBe(true)
    expect(hasName(wordText('where is the cave'), 'the cave')).toBe(true) // the article is not part of a name
    expect(hasName(wordText('did we fix the sinks yet'), 'sink')).toBe(true) // a plain plural names it too
    expect(hasName(wordText('the sinkhole'), 'sink')).toBe(false)
  })

  it('resolves first person to the authenticated sender and adds a possessive-dropped half', () => {
    const speaker = { memberId: '1', firstName: 'Charli' }
    expect(lookupText('who is in my room?', speaker)).toBe(" who is in charli's room | who is in charli room ")
    expect(lookupText("am I on the list? I'm not sure", speaker)).toContain(' am charli on the list charli not sure ')
    expect(lookupText('who is in my room?')).toBe(' who is in my room ') // no sender → nothing substituted
  })
})

describe('matchEntities', () => {
  const rows = [
    { id: 'zuzka', name: 'zuzka', aliases: [], kind: 'person' },
    { id: 'house', name: 'house', aliases: [], kind: 'place' },
    { id: 'room', name: 'room', aliases: [], kind: 'place' },
    { id: 'mroom', name: "marco's room", aliases: [], kind: 'place' },
    { id: 'croom', name: "charli's room", aliases: [], kind: 'place' },
    { id: 'sink', name: 'kitchen sink', aliases: [], kind: 'thing' },
    { id: 'charli', name: 'charli smith', aliases: ['charli'], kind: 'person' },
    { id: 'al', name: 'al', aliases: [], kind: 'person', similarity: 0.7 },
  ]
  const ids = (q: string) => matchEntities(rows, lookupText(q)).map((m) => `${m.id}:${m.kind}`)

  it('a named subject ranks above the house hub', () => {
    expect(ids('is zuzka staying at our house?')).toEqual(['zuzka:named', 'house:hub'])
  })
  it('the longer name wins: "room" inside "marco\'s room" is only a part', () => {
    expect(ids("is marco's room free?")).toEqual(['mroom:named', 'room:part'])
    expect(ids("who's in charli's room?").sort()).toEqual(['charli:part', 'croom:named', 'room:part'])
  })
  it('a bare head finds its qualified node (read side) — never a possessive one', () => {
    expect(ids('is the sink fixed?')).toEqual(['sink:fuzzy'])
    expect(ids('who is in the room?')).toEqual(['room:named'])
  })
  it('aliases match; short names never match by trigram', () => {
    expect(ids('is charli around?')).toEqual(['charli:named'])
    expect(ids('are we all in?')).toEqual([])
  })
})

describe('askedAuthor + cues', () => {
  const roster = new Map([
    ['1', 'Charli Smith'],
    ['2', 'Marco'],
    ['3', 'Sam Lee'],
    ['4', 'Sam Ko'],
  ])
  it('a say-verb plus exactly one housemate', () => {
    expect(askedAuthor('what did Marco say about the budget?', roster)).toBe('2')
    expect(askedAuthor('what did charli mention about the plumber', roster)).toBe('1')
    expect(askedAuthor('is marco home?', roster)).toBeNull() // no say-verb
    expect(askedAuthor('what did sam say?', roster)).toBeNull() // ambiguous first name
    expect(askedAuthor('what did Sam Lee say?', roster)).toBe('3')
    expect(askedAuthor('what did I say about the bins?', roster, { memberId: '2', firstName: 'Marco' })).toBe('2')
  })
  it('question words cue predicates', () => {
    expect(cuedPredicates(lookupText("who's staying this weekend?"))).toEqual(expect.arrayContaining(['has_guest', 'stays_in']))
    expect(cuedPredicates(lookupText('when do the bins go out?'))).toContain('collection_day')
  })
})

import { describe, it, expect } from 'vitest'
import { joinAnd, addAck, checkoffAck, removeAck, renameAck, renderList, categorizeAck } from '@/lib/lists/format'

describe('list acks — deterministic, in Baumy voice', () => {
  it('joinAnd reads naturally at 0/1/2/3 items', () => {
    expect(joinAnd([])).toBe('')
    expect(joinAnd(['milk'])).toBe('milk')
    expect(joinAnd(['milk', 'eggs'])).toBe('milk and eggs')
    expect(joinAnd(['milk', 'eggs', 'bin bags'])).toBe('milk, eggs and bin bags')
  })

  describe('addAck', () => {
    it('all new → what was added + the new count', () => {
      expect(addAck(['milk', 'eggs'], [], 5)).toContain('Added milk and eggs')
      expect(addAck(['milk', 'eggs'], [], 5)).toContain('5 on the list now')
    })
    it('some already there → notes both', () => {
      const s = addAck(['eggs'], ['milk'], 4)
      expect(s).toContain('Added eggs')
      expect(s).toContain('milk was already on there')
    })
    it('all already there → nothing to add', () => {
      expect(addAck([], ['milk'], 3)).toContain("milk's already on the list")
      expect(addAck([], ['milk', 'eggs'], 3)).toContain('milk and eggs are already on the list')
    })
  })

  describe('checkoffAck', () => {
    it('checked off some, list still has items', () => {
      const s = checkoffAck(['milk', 'eggs'], [], ['bin bags', 'coffee'])
      expect(s).toContain('Checked off milk and eggs')
      expect(s).toContain('2 left: bin bags and coffee')
    })
    it('checked off the last item → clears the list', () => {
      expect(checkoffAck(['milk'], [], [])).toContain('That clears the list')
    })
    it('one item was not on the list → says so, keeps the rest', () => {
      const s = checkoffAck(['milk'], ['nutmeg'], ['eggs'])
      expect(s).toContain('Checked off milk')
      expect(s).toContain('Couldn\'t find "nutmeg" on the list')
    })
    it('nothing matched → nothing to check off', () => {
      expect(checkoffAck([], ['nutmeg'], ['milk'])).toContain('nothing to check off')
    })
    it('many remaining → just a count, not a wall of items', () => {
      const s = checkoffAck(['x'], [], ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
      expect(s).toContain('7 left.')
      expect(s).not.toContain('a, b, c')
    })
  })

  describe('renderList', () => {
    it('empty list', () => {
      expect(renderList([])).toContain("shopping list's empty")
    })
    it('non-empty list → header + bullets, plain text (no markdown)', () => {
      const s = renderList(['bin bags', 'dish soap', 'coffee'])
      expect(s).toContain('Shopping list — 3 open:')
      expect(s).toContain('• bin bags')
      expect(s).toContain('• coffee')
      expect(s).not.toContain('**') // Telegram plain text — never markdown
    })
  })

  describe('removeAck (issue #23)', () => {
    it('says what came off — never "bought" — and what is left', () => {
      const s = removeAck(['milk'], [], ['eggs'])
      expect(s).toBe('Took milk off the list. 1 left: eggs.')
      expect(s).not.toMatch(/bought|checked/i)
      expect(removeAck(['milk'], [], [])).toContain("The list's empty now")
    })
    it('names what was not on the list; nothing found → nothing taken off', () => {
      expect(removeAck(['milk'], ['nutmeg'], [])).toContain('Couldn\'t find "nutmeg" on it though')
      expect(removeAck([], ['nutmeg'], ['milk'])).toBe('Couldn\'t find "nutmeg" on the list — nothing taken off. 😼')
    })
  })

  describe('renameAck (issue #23)', () => {
    it('a rename, and a merge said as such', () => {
      expect(renameAck([{ from: 'mlik', to: 'milk', merged: false }], [], ['milk'])).toBe('Changed "mlik" to "milk". 1 left: milk.')
      expect(renameAck([{ from: 'mlik', to: 'milk', merged: true }], [], ['milk'])).toBe('Merged "mlik" into "milk" — it was already on the list. 1 left: milk.')
    })
    it('not found → says so and that nothing changed', () => {
      expect(renameAck([], ['mlik'], ['milk'])).toBe('Couldn\'t find "mlik" on the list — nothing changed. 😼')
      expect(renameAck([{ from: 'bred', to: 'bread', merged: false }], ['mlik'], ['bread'])).toContain('Couldn\'t find "mlik" on the list though.')
    })
  })

  describe('categorizeAck (issue #29)', () => {
    it('where each item went, and that it will be remembered', () => {
      expect(categorizeAck([{ item: 'coffee filters', category: 'coffee' }], [])).toBe("Put coffee filters under Coffee. I'll remember that next time. 🐈‍⬛")
      expect(categorizeAck([{ item: 'candles', category: null }], [])).toBe("candles is Not sorted now. I'll remember that next time. 🐈‍⬛")
    })
    it('a miss, an ambiguous name and a section that is not one of the six — nothing changed for those', () => {
      expect(categorizeAck([], ['nutmeg'])).toBe('Couldn\'t find "nutmeg" on the list — nothing sorted. 😼')
      expect(categorizeAck([], [], [{ item: 'a sponge', matches: ['sponge', 'sponges'] }])).toBe('"a sponge" matches more than one item (sponge and sponges) — nothing sorted; say which one. 😼')
      expect(categorizeAck([], [], [], [{ item: 'tea', category: 'drinks' }])).toBe(
        '"drinks" isn\'t a section — the sections are Pantry, Fresh, Coffee, Cleaning, Maintenance or Household. 😼',
      )
      expect(categorizeAck([], [])).toBe('Nothing to sort there. 😼')
    })
  })

  describe('ambiguous remove / rename — distinct from not found', () => {
    const amb = [{ item: 'sponge', matches: ['sponge cloth', 'sponges'] }]
    it('names the items it could mean, and that nothing changed', () => {
      const r = removeAck([], [], ['sponge cloth', 'sponges'], amb)
      expect(r).toBe('"sponge" matches more than one item (sponge cloth and sponges) — nothing taken off; say which one. 😼')
      expect(r).not.toMatch(/couldn't find/i)
      expect(renameAck([], [], [], amb)).toBe('"sponge" matches more than one item (sponge cloth and sponges) — nothing changed; say which one. 😼')
    })
    it('alongside a miss and a success, each is said separately', () => {
      const r = removeAck(['milk'], ['nutmeg'], ['sponge cloth', 'sponges'], amb)
      expect(r).toBe(
          'Took milk off the list. Couldn\'t find "nutmeg" on it though. "sponge" matches more than one item (sponge cloth and sponges) — say which one. 2 left: sponge cloth and sponges.',
      )
      expect(renameAck([], ['nutmeg'], [], amb)).toBe(
        'Couldn\'t find "nutmeg" on the list — nothing changed. "sponge" matches more than one item (sponge cloth and sponges) — say which one. 😼',
      )
    })
  })
})

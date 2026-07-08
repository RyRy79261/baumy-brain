import { describe, it, expect } from 'vitest'
import { joinAnd, addAck, checkoffAck, renderList } from '@/lib/lists/format'

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
})

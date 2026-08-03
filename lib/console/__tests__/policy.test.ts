import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { POLICY, TABLES, classOf, displayableColumns, editableColumns } from '@/lib/console/policy'

// The drift guard. The console renders from the policy, so an unclassified column is an unpoliced
// one — this test is what stops db/schema.ts growing a field that reaches the UI (or a future edit
// allowlist) without a deliberate verdict.

describe('column policy covers the whole schema', () => {
  it('classifies every column of every table, and invents none', () => {
    const missing: string[] = []
    const extra: string[] = []
    for (const [table, t] of Object.entries(TABLES)) {
      const real = new Set(Object.keys(getTableColumns(t)))
      const declared = new Set(Object.keys(POLICY[table] ?? {}))
      for (const c of real) if (!declared.has(c)) missing.push(`${table}.${c}`)
      for (const c of declared) if (!real.has(c)) extra.push(`${table}.${c}`)
    }
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('covers every table in the schema (no table left unpoliced)', () => {
    expect(Object.keys(TABLES).sort()).toEqual(Object.keys(POLICY).sort())
  })
})

describe('the four classes hold the line', () => {
  it('never displays an encrypted value or a login credential', () => {
    // These are the only columns that can hold a secret at rest. displayableColumns is the SELECT
    // allowlist, so excluding them here means no view can leak one by forgetting to.
    expect(classOf('memoryItems', 'contentEncrypted')).toBe('secret')
    expect(classOf('facts', 'valueCiphertext')).toBe('secret')
    expect(classOf('facts', 'valueIv')).toBe('secret')
    expect(classOf('dashboardLoginTokens', 'tokenHash')).toBe('secret')
    expect(displayableColumns('memoryItems')).not.toContain('contentEncrypted')
    expect(displayableColumns('facts')).not.toContain('valueCiphertext')
    expect(displayableColumns('dashboardLoginTokens')).not.toContain('tokenHash')
  })

  it('marks the derived columns that a hand-edit would silently corrupt', () => {
    // content_tsv is GENERATED ALWAYS so Postgres refuses a write; embedding is application-
    // maintained and Postgres does NOT refuse it — policy is the only guard on that one.
    expect(classOf('memoryItems', 'contentTsv')).toBe('derived')
    expect(classOf('memoryEmbeddings', 'embedding')).toBe('derived')
    expect(classOf('entities', 'nameEmbedding')).toBe('derived')
    expect(classOf('listItems', 'itemNormalized')).toBe('derived')
  })

  it('protects the bitemporal fact chain and the trust gate as provenance', () => {
    for (const col of ['isCurrent', 'supersededBy', 'derivedFromFactId', 'sourceMemoryItemId', 'trustLevel', 'recordedAt', 'validFrom', 'validTo']) {
      expect(classOf('facts', col)).toBe('provenance')
    }
    // …so none of them can ever appear in an edit allowlist.
    const editable = editableColumns('facts')
    expect(editable).not.toContain('isCurrent')
    expect(editable).not.toContain('trustLevel')
    expect(editable).not.toContain('recordedAt')
  })

  it('protects the exactly-once reminder state machine and the fixed destination', () => {
    expect(classOf('reminders', 'status')).toBe('provenance') // hand-editing can double-send or zero-fire
    expect(classOf('reminders', 'deliverChatId')).toBe('provenance') // the LLM never picks a recipient; neither does a text box
    expect(editableColumns('reminders')).toContain('content')
  })

  it('protects the confirm wall: a proposal cannot be edited after it was shown to the human', () => {
    expect(classOf('pendingActions', 'payload')).toBe('provenance')
    expect(classOf('pendingActions', 'status')).toBe('provenance')
    expect(editableColumns('pendingActions')).toEqual([])
  })

  it('keeps live authorization out of the editable surface', () => {
    expect(classOf('members', 'canAccessDashboard')).toBe('provenance')
    expect(classOf('members', 'role')).toBe('provenance')
    // The fixed send destination is config, not a text box — the whole point of sendToHouse is
    // that the recipient is code-resolved.
    expect(classOf('houseConfig', 'houseGroupChatId')).toBe('provenance')
    expect(editableColumns('houseConfig')).not.toContain('houseGroupChatId')
  })

  it('every policy entry that is not open carries a rationale', () => {
    // A verdict without a reason rots — the next person cannot tell a considered "provenance" from
    // a lazy one. Only `open` (the default, boring case) may go unexplained.
    const unexplained: string[] = []
    for (const [table, cols] of Object.entries(POLICY)) {
      for (const [col, p] of Object.entries(cols)) {
        if (p.cls !== 'open' && !p.why) unexplained.push(`${table}.${col}`)
      }
    }
    expect(unexplained).toEqual([])
  })
})

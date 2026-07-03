import { describe, it, expect } from 'vitest'
import { parseReportCommand } from '@/lib/pipeline/report'

describe('parseReportCommand', () => {
  it('parses /bug and /feature with the typed body', () => {
    expect(parseReportCommand('/bug the reminders fire twice')).toEqual({ hint: 'bug', body: 'the reminders fire twice' })
    expect(parseReportCommand('/feature add a dark mode')).toEqual({ hint: 'feature', body: 'add a dark mode' })
  })

  it('treats /issue and /report as auto (the enricher picks the type)', () => {
    expect(parseReportCommand('/issue something odd')?.hint).toBe('auto')
    expect(parseReportCommand('/report x')?.hint).toBe('auto')
  })

  it('strips a @botname suffix (group chats append it)', () => {
    expect(parseReportCommand('/bug@baumy_bot broken')).toEqual({ hint: 'bug', body: 'broken' })
  })

  it('handles an empty body (prompt-for-details case)', () => {
    expect(parseReportCommand('/bug')).toEqual({ hint: 'bug', body: '' })
  })

  it('returns null for non-report messages (and does not eat /bugfix)', () => {
    expect(parseReportCommand('hello there')).toBeNull()
    expect(parseReportCommand('/dashboard')).toBeNull()
    expect(parseReportCommand('/bugfix the thing')).toBeNull()
    expect(parseReportCommand(null)).toBeNull()
  })
})

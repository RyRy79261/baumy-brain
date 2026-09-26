import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { now, withSimulatedTime } from '@/lib/core/clock'

// T13: every time read in lib/** goes through the clock seam, so a sandbox run at a simulated instant
// sees ONE "now" — reports, recency, consolidation, reminders and memory rows all agree. The one
// deliberate exception is the auth layer (a simulated clock must never stretch a session or revive a
// magic link). This guard fails on any new wall-clock read in production code.
const ROOT = join(__dirname, '..', '..')
const ALLOWED = new Set(['core/clock.ts'])
const EXEMPT_DIRS = ['auth/', '__tests__/']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('the clock seam (T13)', () => {
  it('no production code under lib/ reads the wall clock directly (auth excepted, on purpose)', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (ALLOWED.has(rel) || EXEMPT_DIRS.some((d) => rel.startsWith(d) || rel.includes(`/${d}`))) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '')
          if (/\bDate\.now\(\)|\bnew Date\(\s*\)/.test(code)) offenders.push(`lib/${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('now() is the simulated instant inside withSimulatedTime and the wall clock outside', () => {
    const at = new Date('2026-03-14T10:00:00Z')
    expect(withSimulatedTime(at, () => now().toISOString())).toBe(at.toISOString())
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000)
  })
})

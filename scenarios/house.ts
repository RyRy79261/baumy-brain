import type { SandboxPerson } from '@/lib/sandbox/harness'

// The default cast for acceptance scenarios. Ids are arbitrary but stable (the sandbox is its own
// universe); Charli owns the house, so owner-only commands (/baumyhere) work as her.
export const HOUSE: SandboxPerson[] = [
  { id: 701, name: 'Charli', role: 'owner' },
  { id: 702, name: 'Marco' },
  { id: 703, name: 'Ryan' },
]

/** A date a reply's MEMORY line can carry: "27 Sep", "Sep 27", "Sat 26", "2026-09-26". */
export const DATE_RE = /\b(\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{1,2}|(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* \d{1,2}|\d{4}-\d{2}-\d{2})\b/

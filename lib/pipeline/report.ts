import type { ReportHint } from '@/lib/ai/issue-enrich'

// Detect a bug/feature report command at the start of a message. Works in the house group
// OR a member DM (deterministic — no LLM, no false positives). Strips a "@botname" suffix
// so "/bug@baumy_bot …" === "/bug …". `/bug` → bug, `/feature` → feature, `/issue` and
// `/report` leave the type to the enricher ("auto"). Returns null for any other message.
export function parseReportCommand(text: string | null | undefined): { hint: ReportHint; body: string } | null {
  if (!text) return null
  const m = text.trim().match(/^\/(bug|feature|issue|report)(?:@\w+)?\b([\s\S]*)$/i)
  if (!m) return null
  const cmd = m[1].toLowerCase()
  const hint: ReportHint = cmd === 'bug' ? 'bug' : cmd === 'feature' ? 'feature' : 'auto'
  return { hint, body: (m[2] ?? '').trim() }
}

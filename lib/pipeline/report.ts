import type { ReportHint } from '@/lib/ai/issue-enrich'

// Detect a bug/feature report command at the start of a message. Works in the house group
// OR a member DM (deterministic — no LLM, no false positives). Strips a "@botname" suffix
// so "/bug@baumy_bot …" === "/bug …". Just two commands — bug vs feature is the only real
// distinction; the enricher can still re-classify the type if the report contradicts it.
// Returns null for any other message.
export function parseReportCommand(text: string | null | undefined): { hint: ReportHint; body: string } | null {
  if (!text) return null
  const m = text.trim().match(/^\/(bug|feature)(?:@\w+)?\b([\s\S]*)$/i)
  if (!m) return null
  return { hint: m[1].toLowerCase() as ReportHint, body: (m[2] ?? '').trim() }
}

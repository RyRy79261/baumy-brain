import { generateText, type LanguageModel } from 'ai'
import { resolveModel } from './registry'
import { REFLECT_SYSTEM } from './prompts'
import { DateTime } from 'luxon'
import { formatEventWindow } from '@/lib/core/calendar'
import { now as clockNow } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'

export interface ReflectFact {
  predicate: string
  value: string
  /** Who said it (display name) and when — the profile attributes + dates what can change (F11). */
  by?: string | null
  saidAt?: Date | null
  /** For a dated happening: when it happens / is over. */
  eventAt?: Date | null
  validTo?: Date | null
}
export interface ReflectNote {
  text: string
  by: string | null
}

// Sleep-time reflection (memory v2 §4): synthesise a durable, plain-language profile
// of ONE person from the house's OWN facts + attributed notes about them. The result
// is stored as a 'system'-trust fact and grounds future answers. The caller feeds only
// already-captured, non-secret, non-quarantined material; attribution + no-invention in the
// prompt. Runs on the 'assess' tier (Sonnet) — it's the synthesis, worth the reasoning,
// and it's background work (a cron), so latency is not user-facing. Returns '' on an
// empty synthesis so the caller can skip the write.
export async function reflectPerson(
  name: string,
  facts: ReflectFact[],
  notes: ReflectNote[],
  model: LanguageModel = resolveModel('assess'),
  tz: string = houseTz(),
): Promise<string> {
  const day = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('d LLL yyyy')
  const factLines = facts
    .map((f) => {
      const meta = [f.by ? `said by ${f.by}` : null, f.saidAt ? day(new Date(f.saidAt)) : null, f.eventAt ? `happens ${formatEventWindow(new Date(f.eventAt), f.validTo ? new Date(f.validTo) : null, tz)}` : null].filter(Boolean)
      return `- ${f.predicate.replace(/_/g, ' ')}: ${f.value}${meta.length ? ` (${meta.join(', ')})` : ''}`
    })
    .join('\n')
  const noteLines = notes.map((n) => `- ${n.by ? `${n.by}: ` : ''}${n.text}`).join('\n')
  const prompt = `PERSON: ${name}\nTODAY: ${day(clockNow())}\n\nFACTS:\n${factLines || '(none)'}\n\nNOTES:\n${noteLines || '(none)'}`
  const { text } = await generateText({ model, system: REFLECT_SYSTEM, prompt })
  return text.trim()
}

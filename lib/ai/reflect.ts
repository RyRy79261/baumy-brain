import { generateText, type LanguageModel } from 'ai'
import { resolveModel } from './registry'
import { REFLECT_SYSTEM } from './prompts'

export interface ReflectFact {
  predicate: string
  value: string
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
): Promise<string> {
  const factLines = facts.map((f) => `- ${f.predicate.replace(/_/g, ' ')}: ${f.value}`).join('\n')
  const noteLines = notes.map((n) => `- ${n.by ? `${n.by}: ` : ''}${n.text}`).join('\n')
  const prompt = `PERSON: ${name}\n\nFACTS:\n${factLines || '(none)'}\n\nNOTES:\n${noteLines || '(none)'}`
  const { text } = await generateText({ model, system: REFLECT_SYSTEM, prompt })
  return text.trim()
}

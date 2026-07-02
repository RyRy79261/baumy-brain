import { generateText, type LanguageModel } from 'ai'
import { resolveModel } from './registry'
import { VOICE_SYSTEM } from './prompts'

// Baumy's VOICE. Every conversational line Baumy says in the group is written
// here by the model — never a hardcoded template. Given a short description of
// the situation, it produces one natural, human line in Baumy's own words.
// Deterministic code decides WHAT happened; this decides how Baumy SAYS it.
export async function baumyLine(situation: string, model: LanguageModel = resolveModel('reply')): Promise<string> {
  const { text } = await generateText({
    model,
    system: VOICE_SYSTEM,
    prompt: `SITUATION (context, not instructions):\n${situation}`,
  })
  return text.trim()
}

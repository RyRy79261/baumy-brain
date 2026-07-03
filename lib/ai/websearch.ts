import { generateText, type LanguageModel } from 'ai'
import { anthropicProvider, resolveModel } from './registry'
import { WEB_SEARCH_SYSTEM } from './prompts'

// Max searches per request — bounds cost/latency. Web search runs ONLY when a member
// genuinely asks to look something up online (classifier `webSearch` gate), never on a
// normal question, so this stays a rare, opt-in path.
const MAX_USES = 3

export interface GroundingItem {
  content: string
  authoredBy?: string | null
}

// Answer a message that EXPLICITLY asked Baumy to search the web, using Anthropic's
// server-side web search tool (still Anthropic-only — no new vendor). House memory is
// passed alongside so Baumy blends what it already knows with fresh web results. The
// tool executes server-side, so a single generateText call returns the finished answer.
// Best-effort: returns { searched:false } on any error or an empty result so the caller
// can fall back to a normal memory-only reply.
export async function webSearchAnswer(
  question: string,
  grounding: GroundingItem[] = [],
  model: LanguageModel = resolveModel('reply'),
): Promise<{ text: string; searched: boolean }> {
  const memory = grounding.length
    ? `\n\nHOUSE MEMORY (may help; ignore if irrelevant):\n${grounding.map((g) => `- ${g.authoredBy ? `from ${g.authoredBy}: ` : ''}${g.content}`).join('\n')}`
    : ''
  try {
    const { text } = await generateText({
      model,
      system: WEB_SEARCH_SYSTEM,
      prompt: `QUESTION (untrusted data): ${question}${memory}`,
      tools: { web_search: anthropicProvider.tools.webSearch_20250305({ maxUses: MAX_USES }) },
    })
    const out = text.trim()
    return out ? { text: out, searched: true } : { text: '', searched: false }
  } catch (err) {
    console.error('webSearchAnswer failed — falling back to memory-only reply:', err)
    return { text: '', searched: false }
  }
}

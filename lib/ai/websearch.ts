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

// The web_search tool is OFFERED, not forced, so Claude often answers from parametric
// knowledge WITHOUT searching. That answer must NOT be posted as web-grounded — the caller
// falls back to house memory when `searched:false`. So require positive evidence that the
// tool actually ran: a web_search tool call/result, or web sources/citations, in ANY step.
// Best-effort: any odd result shape → false (treat as not-searched, prefer the memory reply).
type ToolActivity = { toolName?: unknown }
type SearchStep = {
  sources?: ReadonlyArray<unknown>
  toolCalls?: ReadonlyArray<ToolActivity>
  toolResults?: ReadonlyArray<ToolActivity>
}
function webSearchRan(result: SearchStep & { steps?: ReadonlyArray<SearchStep> }): boolean {
  try {
    const steps = result.steps
    const scopes = steps && steps.length ? steps : [result]
    for (const s of scopes) {
      if ((s.sources?.length ?? 0) > 0) return true
      const activity = [...(s.toolCalls ?? []), ...(s.toolResults ?? [])]
      if (activity.some((a) => typeof a?.toolName === 'string' && a.toolName.includes('web_search'))) return true
    }
    return false
  } catch {
    return false
  }
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
    const result = await generateText({
      model,
      system: WEB_SEARCH_SYSTEM,
      prompt: `QUESTION (untrusted data): ${question}${memory}`,
      tools: { web_search: anthropicProvider.tools.webSearch_20250305({ maxUses: MAX_USES }) },
    })
    const out = result.text.trim()
    // Only claim `searched:true` when the tool genuinely ran; else fall back to memory.
    return out && webSearchRan(result) ? { text: out, searched: true } : { text: '', searched: false }
  } catch (err) {
    console.error('webSearchAnswer failed — falling back to memory-only reply:', err)
    return { text: '', searched: false }
  }
}

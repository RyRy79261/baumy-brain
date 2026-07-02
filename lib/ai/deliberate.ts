import { generateText, type LanguageModel } from 'ai'
import { resolveModel } from './registry'

// Deliberative-path run (assess/advisor) for on-demand audits + scheduled tasks.
// The REACTIVE reply path NEVER reaches this. Web search is a deploy-time
// pluggable tool (verify-at-build); v1 reasons over the prompt tool-less.
const SYSTEM = [
  'You are Baumy handling a deliberate house task (an on-demand check or a scheduled query) for the house group.',
  'Answer usefully and concisely; plain text. Do not take destructive actions.',
  'The task prompt comes from a trusted house member.',
].join(' ')

export async function deliberate(prompt: string, model: LanguageModel = resolveModel('assess')): Promise<string> {
  const { text } = await generateText({ model, system: SYSTEM, prompt })
  return text
}

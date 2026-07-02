import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { resolveModel } from './registry'
import { EXTRACT_REMINDER_SYSTEM } from './prompts'

// Reminder detection + slot extraction (task-graph R1 / llm-pipeline T14).
// The message is untrusted DATA; the structured schema constrains the output.
export const reminderExtraction = z.object({
  isReminder: z.boolean(),
  whenText: z.string(), // the time phrase, verbatim (e.g. "in 3 days", "a week before friday")
  content: z.string(), // what to remind the house about
})
export type ReminderExtraction = z.infer<typeof reminderExtraction>

export async function extractReminder(
  text: string,
  model: LanguageModel = resolveModel('classify'),
): Promise<ReminderExtraction> {
  const { object } = await generateObject({
    model,
    schema: reminderExtraction,
    system: EXTRACT_REMINDER_SYSTEM,
    prompt: `MESSAGE (data): ${text}`,
  })
  return object
}

import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'

// All registered Inngest functions. Reminders (arm/deliver/sweeper), the
// scheduled-task dispatcher, digests, and consolidation are appended in
// Phases 3–5.
export const functions: InngestFunction.Any[] = [handleTelegramMessage]

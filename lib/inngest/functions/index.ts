import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'
import { reminderArm, reminderDeliver, reminderSweeper } from './reminders'

// All registered Inngest functions. Scheduled-task dispatcher, digests, and
// consolidation are appended in Phases 5+.
export const functions: InngestFunction.Any[] = [
  handleTelegramMessage,
  reminderArm,
  reminderDeliver,
  reminderSweeper,
]

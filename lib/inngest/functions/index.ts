import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'
import { reminderArm, reminderDeliver, reminderSweeper } from './reminders'
import { scheduledTaskDispatch } from './scheduled-tasks'

// All registered Inngest functions. Consolidation/decay + the ad-hoc nudge path
// are appended in later phases.
export const functions: InngestFunction.Any[] = [
  handleTelegramMessage,
  reminderArm,
  reminderDeliver,
  reminderSweeper,
  scheduledTaskDispatch,
]

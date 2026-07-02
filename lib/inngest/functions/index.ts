import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'
import { handleMyChatMember } from './chat-member'
import { reminderArm, reminderDeliver, reminderSweeper } from './reminders'
import { scheduledTaskDispatch } from './scheduled-tasks'

// All registered Inngest functions.
export const functions: InngestFunction.Any[] = [
  handleTelegramMessage,
  handleMyChatMember,
  reminderArm,
  reminderDeliver,
  reminderSweeper,
  scheduledTaskDispatch,
]

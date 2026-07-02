import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'
import { handleCallbackQuery } from './callback'
import { handleMyChatMember, handleChatMember } from './chat-member'
import { reminderArm, reminderDeliver, reminderSweeper } from './reminders'
import { scheduledTaskDispatch } from './scheduled-tasks'
import { reembedSweep } from './reembed'

// All registered Inngest functions.
export const functions: InngestFunction.Any[] = [
  handleTelegramMessage,
  handleCallbackQuery,
  handleMyChatMember,
  handleChatMember,
  reminderArm,
  reminderDeliver,
  reminderSweeper,
  scheduledTaskDispatch,
  reembedSweep,
]

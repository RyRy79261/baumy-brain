import type { InngestFunction } from 'inngest'
import { handleTelegramMessage } from './ingest'
import { handleCallbackQuery } from './callback'
import { handleMyChatMember, handleChatMember } from './chat-member'
import { reminderArm, reminderDeliver, reminderDigest } from './reminders'
import { reembedSweep } from './reembed'
import { reflectSweep } from './reflect'
import { eventSurfacingScan } from './surfacing'
import { consolidationSweep } from './consolidation'

// All registered Inngest functions.
export const functions: InngestFunction.Any[] = [
  handleTelegramMessage,
  handleCallbackQuery,
  handleMyChatMember,
  handleChatMember,
  reminderArm,
  reminderDeliver,
  reminderDigest,
  reembedSweep,
  reflectSweep,
  eventSurfacingScan,
  consolidationSweep,
]

import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'

// The house group's chat id. Source of truth is house_config.house_group_chat_id,
// which is auto-captured the moment the bot is added to the group (see
// handleMyChatMember). BAUMY_HOUSE_CHAT_ID is an OPTIONAL override — set it only
// if you want to pin the group explicitly; otherwise the invite decides.
// Returns '' before the bot has been added anywhere (nothing is in scope yet).
export async function getHouseChatId(db: Database): Promise<string> {
  const override = process.env.BAUMY_HOUSE_CHAT_ID
  if (override && override !== '') return override
  const [cfg] = await db.select({ id: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
  return cfg?.id ?? ''
}

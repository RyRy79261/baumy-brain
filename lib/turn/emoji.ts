import type { ReactionTypeEmoji } from 'grammy/types'

// The reactions Baumy may put on a message (docs/spec/chat-understanding-v2.md §3). Every member
// MUST be in the Bot API's ReactionTypeEmoji allow-list: setMessageReaction 400s
// (REACTION_INVALID) on anything else, so an off-list emoji is an acknowledgement that silently
// never appears (K1 — the old 🧠 "learned it" ack never rendered once). The `satisfies` clause
// makes tsc reject an off-list member; lib/turn/__tests__/emoji.test.ts re-checks it against the
// installed grammY type union at runtime so a Bot API type bump can't slip past either.
//
//   ✍ noted it (a statement was remembered / an item went on the list)
//   👍 done — agreeing to a directive (reminder set, item checked off)
//   👎 honest miss on an ambient ask
//   👀 seen — thinking, or nothing new to file
//   🔥 🎉 🤯 😁 genuine vibes the classifier felt
export const PLANNER_EMOJI = ['✍', '👍', '👎', '👀', '🔥', '🎉', '🤯', '😁'] as const satisfies readonly ReactionTypeEmoji['emoji'][]

export type PlannerEmoji = (typeof PLANNER_EMOJI)[number]

/** "Noted" — the Bot-API-valid replacement for 🧠 (spec decision D5). */
export const NOTED: PlannerEmoji = '✍'

export const isPlannerEmoji = (e: string): e is PlannerEmoji => (PLANNER_EMOJI as readonly string[]).includes(e)

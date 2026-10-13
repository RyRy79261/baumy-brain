// Baumy's Telegram slash-command menus: the ONE list both the manual script
// (scripts/set-commands.ts) and the deploy step (scripts/maybe-set-commands.mjs) register.
// Plain .mjs so the build step runs it with plain `node` (no TypeScript loader).
//
// Design: Baumy is natural-language-first, so the menus stay short. The menu is UX, never
// authorization — every command is gated in code (lib/turn/commands.ts, lib/identity/commands.ts).
// - Owner power-commands (/pause, /resume) are intentionally NOT advertised; they still work
//   when typed (gated by isOwner in lib/identity/commands.ts).
// - The topic setup commands stay unadvertised too. /notifyhere and /baumyhere are owner-only.
//   /shoppinghere and /shoppingoff work for any member, but they are one-time setup, not
//   everyday commands: /shoppinghere MOVES the house's one live list into the topic it is sent
//   in, and /shoppingoff takes the list down for everyone. Shown in every topic's "/" menu they
//   would invite an accidental move or shutdown; /list (advertised) is the everyday command,
//   and the setup steps live in the README's shopping-list section.
// - /list (the live shopping list) is in the GROUP menu only: it runs in the house lane only
//   (lib/turn/commands.ts); in a DM it is not a command.

// Report commands work in the group AND DMs (lib/turn/commands.ts) — advertise them in both
// menus so housemates can file a bug / feature request from anywhere.
export const REPORT_COMMANDS = [
  { command: 'weekly', description: "Weekly report — what's been happening" },
  { command: 'guests', description: "Upcoming guests — who's in which room" },
  { command: 'bug', description: 'Report a bug (Baumy files a GitHub issue)' },
  { command: 'feature', description: 'Request a feature (Baumy files a GitHub issue)' },
]

export const GROUP_COMMANDS = [{ command: 'list', description: 'Show the live shopping list' }, ...REPORT_COMMANDS]

export const DM_COMMANDS = [
  { command: 'start', description: 'What Baumy is + how to use it' },
  { command: 'dashboard', description: 'Get a one-time dashboard login link' },
  { command: 'link', description: 'Link your Telegram to Baumy Olympics (/link <code>)' },
  ...REPORT_COMMANDS,
]

// One setMyCommands call per entry. `scope` undefined = Telegram's default (fallback) menu.
export const COMMAND_MENUS = [
  { name: 'default', commands: DM_COMMANDS, scope: undefined },
  { name: 'all_private_chats', commands: DM_COMMANDS, scope: { type: 'all_private_chats' } },
  { name: 'all_group_chats', commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } },
]

/**
 * Register every menu in COMMAND_MENUS. Returns one result per menu; a network error or a
 * Telegram refusal is reported in it, never thrown. The token never appears in a result.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{ name: string, ok: boolean, description?: string }>>}
 */
export async function registerCommandMenus(token, fetchImpl = fetch) {
  const results = []
  for (const menu of COMMAND_MENUS) {
    const body = menu.scope ? { commands: menu.commands, scope: menu.scope } : { commands: menu.commands }
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const json = /** @type {{ ok?: boolean, description?: string }} */ (await res.json().catch(() => ({})))
      results.push({ name: menu.name, ok: json.ok === true, ...(json.ok === true ? {} : { description: redact(json.description ?? `HTTP ${res.status}`, token) }) })
    } catch (e) {
      results.push({ name: menu.name, ok: false, description: redact(e instanceof Error ? e.message : String(e), token) })
    }
  }
  return results
}

/** @param {string} text @param {string} token */
function redact(text, token) {
  return token ? text.split(token).join('[redacted]') : text
}

// Register Baumy's slash-command menus by SCOPE (run once, or after changing them).
// Run:  node --experimental-strip-types scripts/set-commands.ts
// Needs: TELEGRAM_BOT_TOKEN
//
// Design: the house GROUP menu is empty — Baumy is natural-language-first there, no
// command clutter (you just talk to it). The DM menu carries the only two commands a
// housemate needs. Owner power-commands (/pause, /resume) are intentionally NOT
// advertised in the menu; they still work when typed (gated by isOwner in
// lib/identity/commands.ts) — the menu is UX, never authorization.

export {} // module scope (isolates top-level names from other scripts under tsc)

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN')
  process.exit(1)
}
const api = `https://api.telegram.org/bot${token}`

async function post(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ ok: boolean; description?: string }>
}

const DM_COMMANDS = [
  { command: 'start', description: 'What Baumy is + how to use it' },
  { command: 'dashboard', description: 'Get a one-time dashboard login link' },
]

async function main() {
  // Default fallback + private chats: the housemate command set.
  console.log('default:', await post('setMyCommands', { commands: DM_COMMANDS }))
  console.log(
    'all_private_chats:',
    await post('setMyCommands', { commands: DM_COMMANDS, scope: { type: 'all_private_chats' } }),
  )
  // Group chats: no commands — keep the house group natural-language-only.
  console.log(
    'all_group_chats:',
    await post('setMyCommands', { commands: [], scope: { type: 'all_group_chats' } }),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

// Register Baumy's slash-command menus by SCOPE by hand (a production deploy also does this,
// through scripts/maybe-set-commands.mjs — issue #27).
// Run:  node --experimental-strip-types scripts/set-commands.ts
// Needs: TELEGRAM_BOT_TOKEN
//
// The menus and their design (what is advertised where, and what stays unadvertised) live in
// scripts/commands.mjs, the one list this script and the deploy step share.

import { registerCommandMenus } from './commands.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN')
  process.exit(1)
}

const results = await registerCommandMenus(token)
for (const r of results) console.log(`${r.name}:`, r.ok ? 'ok' : `failed (${r.description})`)
if (!results.every((r) => r.ok)) process.exit(1)

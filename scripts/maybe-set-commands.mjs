// Register Baumy's Telegram command menus during `vercel-build`, ONLY on a production deploy
// with a bot token (issue #27). Previews share the production bot, so they must never touch
// its menu. Like scripts/maybe-migrate.mjs this is a build-time step — but a Telegram error
// must NEVER fail the deploy: it logs and exits 0. The lists live in scripts/commands.mjs.
import { pathToFileURL } from 'node:url'
import { registerCommandMenus } from './commands.mjs'

/**
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (msg: string) => void }} [opts]
 * @returns {Promise<'skipped' | 'done' | 'failed'>}
 */
export async function maybeSetCommands({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (env.VERCEL_ENV !== 'production') {
    log(`[baumy] Not a production deploy (VERCEL_ENV=${env.VERCEL_ENV ?? 'unset'}) — skipping the Telegram command menus.`)
    return 'skipped'
  }
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) {
    log('[baumy] No TELEGRAM_BOT_TOKEN set — skipping the Telegram command menus.')
    return 'skipped'
  }
  try {
    const results = await registerCommandMenus(token, fetchImpl)
    for (const r of results) log(`[baumy] setMyCommands ${r.name}: ${r.ok ? 'ok' : `failed (${r.description})`}`)
    if (results.every((r) => r.ok)) return 'done'
  } catch (e) {
    log(`[baumy] Could not register the Telegram command menus: ${e instanceof Error ? e.name : 'error'}`)
  }
  log('[baumy] Continuing the build without updating the command menus.')
  return 'failed'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never exit non-zero: the deploy must not depend on Telegram.
  await maybeSetCommands().catch(() => {})
}

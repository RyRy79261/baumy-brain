// Brings the e2e stack up once per run and down at the end (e2e/README.md). All local, in Docker:
//   1. the fake server (Telegram, Olympics, Claude, Voyage) on this machine
//   2. Postgres 17 + pgvector behind the two Neon proxies, migrated by the real `pnpm db:migrate`
//   3. the Inngest dev server, and a production build of this checkout (`next start`) with test
//      settings: the local database, a fake bot token, the fake Telegram as its Bot API, the fake
//      Olympics, and a fake Claude + Voyage answering from e2e/script.ts. No key, no cost.
//   4. the house onboarded the real way: Chloe adds the bot, Marco and Ryan join
// E2E_KEEP=1 leaves everything up (and prints how to reach it) for debugging.

import { randomBytes, randomInt } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { TestProject } from 'vitest/node'
import * as schema from '@/db/schema'
import { FAKE_OLYMPICS_TOKEN } from '@/scenarios/olympics-fake'
import { startFakeServer } from './fake-server'
import { fixtures } from './script'
import { startDatabase, migrate, buildApp, freePort, startApp, startInngest } from './infra'
import { House, type StackInfo } from './house-driver'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const secret = (n = 24) => randomBytes(n).toString('hex')

export const PEOPLE = [
  { id: 7_100_000_001, name: 'Chloe', role: 'owner' as const },
  { id: 7_100_000_002, name: 'Marco' },
  { id: 7_100_000_003, name: 'Ryan' },
]

export default async function setup(project: TestProject) {
  const log = (s: string) => console.log(`[e2e] ${s}`)
  const downs: (() => Promise<void> | void)[] = []
  const teardown = async () => {
    if (process.env.E2E_KEEP) return log('E2E_KEEP set: leaving the stack up')
    for (const d of downs.reverse()) await Promise.resolve(d()).catch((e) => console.warn('[e2e] teardown step failed:', e))
  }

  try {
    const botId = 8_000_000_000 + randomInt(1_000_000)
    const bot = { id: botId, username: 'baumy_e2e_bot' }
    const houseChatId = -(1_000_000_000_000 + randomInt(1_000_000_000))
    const controlToken = secret()

    const fake = await startFakeServer({
      botId, botUsername: bot.username, houseChatId, people: PEOPLE, controlToken, fixtures,
      olympicsMembers: PEOPLE.map((p) => ({ id: `m-${p.name.toLowerCase()}`, displayName: p.name, telegramUserId: String(p.id) })),
    })
    downs.push(() => fake.close())
    log(`fake Telegram, Olympics, Claude and Voyage at ${fake.url}`)

    log('building the app and starting Postgres (a few minutes)…')
    const [database] = await Promise.all([startDatabase(), buildApp()])
    downs.push(() => database.stop())
    await migrate(database.direct)
    log('database migrated')

    const port = await freePort()
    const inngest = await startInngest(port)
    downs.push(() => inngest.stop())
    log(`Inngest dev server at ${inngest.url}`)

    const webhookSecret = secret()
    const app = await startApp(port, {
      ANTHROPIC_API_KEY: 'e2e-fake',
      ANTHROPIC_BASE_URL: `${fake.url}/anthropic/v1`,
      VOYAGE_API_KEY: 'e2e-fake',
      VOYAGE_BASE_URL: `${fake.url}/voyage/v1`,
      ...database.proxyEnv,
      DATABASE_URL: database.appUrl,
      DATABASE_URL_UNPOOLED: database.appUrl,
      TELEGRAM_BOT_TOKEN: `${botId}:${secret(18)}`,
      TELEGRAM_API_ROOT: fake.url,
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_USERNAME: bot.username,
      OLYMPICS_BASE_URL: `${fake.url}/olympics`,
      BRAIN_SERVICE_TOKEN: FAKE_OLYMPICS_TOKEN,
      KITCHEN_API_TOKEN: secret(),
      BAUMY_SESSION_SECRET: secret(),
      BAUMY_ENCRYPTION_KEY: secret(),
      BAUMY_PUBLIC_URL: 'https://e2e.invalid',
      INNGEST_DEV: '1',
      INNGEST_BASE_URL: inngest.url,
      // How the Inngest container reaches this app (through the Docker host gateway).
      INNGEST_SERVE_HOST: `http://host.docker.internal:${port}`,
    })
    downs.push(() => app.stop())
    downs.push(() => { if (process.env.E2E_APP_LOG) console.log(app.logs()) })
    log(`app at ${app.url}`)

    // Register the functions with the dev server (an in-band sync), then wait until it lists them.
    const sync = await fetch(`${app.url}/api/inngest`, { method: 'PUT' })
    log(`Inngest sync: ${sync.status} ${(await sync.text()).slice(0, 200)}`)

    const info: StackInfo = {
      baseUrl: app.url, webhookSecret,
      controlUrl: fake.url, controlToken,
      dbUrl: database.direct, bot, houseChatId, people: PEOPLE,
    }

    const h = new House(info)
    await onboard(h, log).finally(() => h.close())
    project.provide('stack', info)
    if (process.env.E2E_KEEP) log(`kept: ${JSON.stringify({ ...info, webhookSecret: '<secret>', controlToken: '<secret>' })} inngest ${inngest.url}`)
  } catch (e) {
    console.error('[e2e] setup failed:', e)
    await teardown()
    throw e
  }
  return teardown
}

// The real onboarding path: the owner adds the bot (my_chat_member), the others join (chat_member).
async function onboard(h: House, log: (s: string) => void): Promise<void> {
  const owner = h.user('Chloe')
  const botUser = { id: h.stack.bot.id, is_bot: true, first_name: 'Baumy', username: h.stack.bot.username }
  const date = Math.floor(Date.now() / 1000)
  await h.post({
    update_id: h.nextUpdateId(),
    my_chat_member: {
      chat: h.houseChat, from: owner, date,
      old_chat_member: { status: 'left', user: botUser },
      new_chat_member: { status: 'administrator', user: botUser, can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: false, can_restrict_members: true, can_promote_members: false, can_change_info: true, can_invite_users: true, can_post_stories: false, can_edit_stories: false, can_delete_stories: false, can_pin_messages: true },
    },
  } as never)
  const db = h.db
  const until = async (what: string, ok: () => Promise<boolean>) => {
    for (let i = 0; i < 90; i++) {
      if (await ok()) return
      await sleep(2000)
    }
    throw new Error(`[e2e] ${what} not done in 3 minutes (is the Inngest container reaching the app?)`)
  }
  // The house exists before anyone joins it (as in real life: a join before it is dropped as not-house).
  await until('the bot add', async () => {
    const [cfg] = await db.select().from(schema.houseConfig).where(eq(schema.houseConfig.id, true))
    return cfg?.houseGroupChatId === String(h.stack.houseChatId)
  })
  for (const name of ['Marco', 'Ryan']) {
    const user = h.user(name)
    await h.post({
      update_id: h.nextUpdateId(),
      chat_member: { chat: h.houseChat, from: user, date, old_chat_member: { status: 'left', user }, new_chat_member: { status: 'member', user } },
    } as never)
  }
  await until('the joins', async () => (await db.select().from(schema.members)).filter((m) => m.isActive).length === 3)
  log('house onboarded: Chloe (owner), Marco, Ryan')
}

import { describe, expect, it, vi } from 'vitest'
import { COMMAND_MENUS, DM_COMMANDS, GROUP_COMMANDS, REPORT_COMMANDS, registerCommandMenus } from '../commands.mjs'
import { maybeSetCommands } from '../maybe-set-commands.mjs'

const TOKEN = '123456:SECRET-token'
const names = (cmds: { command: string }[]) => cmds.map((c) => c.command)

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('command menus (scripts/commands.mjs)', () => {
  it('advertises /list in the group menu, not in the DM menu', () => {
    expect(names(GROUP_COMMANDS)).toContain('list')
    expect(names(DM_COMMANDS)).toContain('start')
    expect(names(DM_COMMANDS)).not.toContain('list')
  })

  it('keeps the report commands in both menus and the setup/owner commands out of both', () => {
    for (const c of names(REPORT_COMMANDS)) {
      expect(names(GROUP_COMMANDS)).toContain(c)
      expect(names(DM_COMMANDS)).toContain(c)
    }
    expect(names(GROUP_COMMANDS).length).toBeGreaterThan(0)
    for (const hidden of ['pause', 'resume', 'notifyhere', 'baumyhere', 'shoppinghere', 'shoppingoff']) {
      expect(names(GROUP_COMMANDS)).not.toContain(hidden)
      expect(names(DM_COMMANDS)).not.toContain(hidden)
    }
  })

  it('registers the default, private and group scopes with the right lists', async () => {
    const fetchImpl = okFetch()
    const results = await registerCommandMenus(TOKEN, fetchImpl)
    expect(results.map((r) => r.name)).toEqual(['default', 'all_private_chats', 'all_group_chats'])
    expect(results.every((r) => r.ok)).toBe(true)
    const bodies = fetchImpl.mock.calls.map((c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string))
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/setMyCommands`)
    expect(bodies[0]).toEqual({ commands: DM_COMMANDS })
    expect(bodies[1]).toEqual({ commands: DM_COMMANDS, scope: { type: 'all_private_chats' } })
    expect(bodies[2]).toEqual({ commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } })
    expect(COMMAND_MENUS).toHaveLength(3)
  })
})

describe('maybeSetCommands (the vercel-build step)', () => {
  it('registers the menus on a production deploy with a token', async () => {
    const fetchImpl = okFetch()
    const log = vi.fn()
    expect(await maybeSetCommands({ env: { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: TOKEN }, fetchImpl, log })).toBe('done')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.flat().join('\n')).toContain('all_group_chats: ok')
  })

  it.each([
    ['preview', { VERCEL_ENV: 'preview', TELEGRAM_BOT_TOKEN: TOKEN }],
    ['development', { VERCEL_ENV: 'development', TELEGRAM_BOT_TOKEN: TOKEN }],
    ['no VERCEL_ENV', { TELEGRAM_BOT_TOKEN: TOKEN }],
    ['no token', { VERCEL_ENV: 'production' }],
  ])('skips without calling Telegram: %s', async (_label, env) => {
    const fetchImpl = okFetch()
    expect(await maybeSetCommands({ env, fetchImpl, log: () => {} })).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a network failure, and never logs the token', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/setMyCommands`)
    }) as unknown as typeof fetch
    const log = vi.fn()
    await expect(maybeSetCommands({ env: { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: TOKEN }, fetchImpl, log })).resolves.toBe('failed')
    const logged = log.mock.calls.flat().join('\n')
    expect(logged).toContain('all_group_chats: failed')
    expect(logged).not.toContain(TOKEN)
  })

  it('swallows a Telegram refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch
    const log = vi.fn()
    expect(await maybeSetCommands({ env: { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: TOKEN }, fetchImpl, log })).toBe('failed')
    expect(log.mock.calls.flat().join('\n')).toContain('failed (Unauthorized)')
  })
})

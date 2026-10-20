// The e2e stack's one local HTTP server (e2e/README.md), reached by the app on 127.0.0.1:
//   POST /bot<token>/<method>   the fake Telegram Bot API (fake-telegram.ts)
//   POST /anthropic/v1/messages the fake Claude (fake-anthropic.ts), as ANTHROPIC_BASE_URL
//   POST /voyage/v1/embeddings  the fake Voyage: embedSync vectors (the offline suite's embedder)
//   *    /olympics/...          the fake Baumy Olympics (scenarios/olympics-fake.ts, the same fake the
//                               offline scenarios use), as OLYMPICS_BASE_URL
//   *    /__control/...         the test driver's side door: read calls, store a housemate's message,
//                               add a fault. Refused unless the request carries the control token.

import http from 'node:http'
import { FakeTelegram, type Fault, type Person } from './fake-telegram'
import { FakeOlympics, FAKE_OLYMPICS_URL, type FakeMember } from '@/scenarios/olympics-fake'
import type { Fixtures } from '@/scenarios/fake-model'
import { embedSync, EMBED_MODEL } from '@/lib/ai/embed'
import { FakeAnthropic, type AiFault } from './fake-anthropic'
import type { Message } from 'grammy/types'

export interface FakeServer {
  url: string
  port: number
  telegram: FakeTelegram
  olympics: FakeOlympics
  anthropic: FakeAnthropic
  close(): Promise<void>
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeServer(o: {
  botId: number
  botUsername: string
  houseChatId: number
  people: Person[]
  olympicsMembers: FakeMember[]
  controlToken: string
  /** What the fake Claude answers (default: the scripted model's safe defaults). */
  fixtures?: Fixtures
  port?: number
}): Promise<FakeServer> {
  const telegram = new FakeTelegram(o)
  const anthropic = new FakeAnthropic(o.fixtures ?? {})
  const olympics = new FakeOlympics({ members: o.olympicsMembers, now: () => Date.now() })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fake')
      const raw = await readBody(req)

      const bot = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/)
      if (bot) {
        // grammY sends JSON (no files in Baumy); a form body would be a new kind of call.
        const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        const answer = await telegram.call(decodeURIComponent(bot[1]), bot[2], params)
        const status = answer.ok ? 200 : answer.error_code
        return json(res, status, answer)
      }

      if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
        if (!req.headers['x-api-key']) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } })
        const [status, answer] = await anthropic.messages(JSON.parse(raw))
        return json(res, status, answer)
      }

      if (url.pathname === '/voyage/v1/embeddings' && req.method === 'POST') {
        if (!req.headers.authorization) return json(res, 401, { detail: 'Unauthorized' })
        const { input } = JSON.parse(raw) as { input: string[] }
        return json(res, 200, { object: 'list', model: EMBED_MODEL, data: input.map((t, index) => ({ object: 'embedding', index, embedding: embedSync(t) })) })
      }

      if (url.pathname.startsWith('/olympics/')) {
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        let answer: Response
        try {
          answer = await olympics.transport(FAKE_OLYMPICS_URL + url.pathname.slice('/olympics'.length), {
            method: req.method,
            headers,
            ...(raw ? { body: raw } : {}),
          })
        } catch {
          // loseNextAnswer: the action ran, but the answer never arrives (a timeout after the commit).
          return req.socket.destroy()
        }
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        return res.end(await answer.text())
      }

      if (url.pathname.startsWith('/__control/')) {
        if (req.headers['x-e2e-control'] !== o.controlToken) return json(res, 403, { error: 'control token' })
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        switch (url.pathname) {
          case '/__control/calls': {
            const since = Number(url.searchParams.get('since') ?? 0)
            return json(res, 200, telegram.calls.filter((c) => c.seq > since))
          }
          case '/__control/message': {
            // A housemate's message: the driver gets its id from the chat's one counter.
            const m = { ...(body.message as Message), message_id: telegram.allocId((body.message as Message).chat.id) } as Message
            return json(res, 200, telegram.store(m))
          }
          case '/__control/find': {
            return json(res, 200, telegram.find(String(body.chatId), Number(body.messageId)) ?? null)
          }
          case '/__control/fault':
            telegram.addFault(body as unknown as Fault)
            return json(res, 200, { ok: true })
          case '/__control/latency':
            telegram.latency = body.range as [number, number]
            return json(res, 200, { ok: true })
          case '/__control/olympics':
            return json(res, 200, { events: olympics.events, calls: olympics.calls, completions: olympics.completions })
          case '/__control/olympics-down':
            olympics.down = Boolean(body.down)
            return json(res, 200, { ok: true })
          case '/__control/ai-calls': {
            const since = Number(url.searchParams.get('since') ?? 0)
            return json(res, 200, anthropic.calls.filter((c) => c.seq > since))
          }
          case '/__control/ai-errors':
            return json(res, 200, anthropic.harnessErrors)
          case '/__control/ai-fault':
            anthropic.addFault(body as unknown as AiFault)
            return json(res, 200, { ok: true })
          case '/__control/reset':
            telegram.reset()
            return json(res, 200, { ok: true })
        }
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  })

  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    telegram,
    olympics,
    anthropic,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

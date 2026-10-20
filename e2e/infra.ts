// The local e2e stack (e2e/README.md), all in Docker on this machine — no cloud account, nothing shared
// with production:
//   - Postgres 17 + pgvector (production's major version), and the two Neon proxies in front of it, so
//     the app talks to it through the SAME @neondatabase/serverless drivers it uses on Neon
//   - the Inngest dev server (the same executor: steps, retries, concurrency keys, sleepUntil, crons)
//   - the app itself: a production `next build` + `next start` on the host
// Every container is removed at the end (and by testcontainers' reaper if the run crashes).

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import { GenericContainer, Network, Wait, type StartedTestContainer, type StartedNetwork } from 'testcontainers'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PG = { user: 'postgres', password: 'postgres', db: 'baumy' }

// Pinned by digest: an upstream push never changes a run. Upgrade on purpose (pull, run, re-pin).
const IMAGES = {
  postgres: 'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d',
  wsproxy: 'ghcr.io/neondatabase/wsproxy:latest@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb',
  httpproxy: 'ghcr.io/timowilhelm/local-neon-http-proxy:main@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a',
  // Inngest dev server 1.46.0
  inngest: 'inngest/inngest:latest@sha256:9c4a2413bdbfa31a94ff54c32ae2dcc6613dbee84bc76db6cf6644d19e357e3e',
}

export interface Database {
  /** Direct URL from this machine (migrations, test reads). */
  direct: string
  /** The app's URL: the host as the proxies see it, inside the Docker network. */
  appUrl: string
  /** Env that points the app's Neon drivers at the proxies (db/local-proxy.ts). */
  proxyEnv: Record<string, string>
  stop(): Promise<void>
}

export async function startDatabase(): Promise<Database> {
  const network: StartedNetwork = await new Network().start()
  const pg = await new GenericContainer(IMAGES.postgres)
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  const ws = await new GenericContainer(IMAGES.wsproxy)
    .withNetwork(network)
    .withEnvironment({ APPEND_PORT: 'postgres:5432', ALLOW_ADDR_REGEX: '.*', LOG_TRAFFIC: 'false' })
    .withExposedPorts(80)
    .start()
  const http = await new GenericContainer(IMAGES.httpproxy)
    .withNetwork(network)
    .withEnvironment({ PG_CONNECTION_STRING: `postgres://${PG.user}:${PG.password}@postgres:5432/${PG.db}` })
    .withExposedPorts(4444)
    .start()
  const containers: StartedTestContainer[] = [http, ws, pg]
  return {
    direct: `postgres://${PG.user}:${PG.password}@127.0.0.1:${pg.getMappedPort(5432)}/${PG.db}`,
    appUrl: `postgres://${PG.user}:${PG.password}@postgres:5432/${PG.db}`,
    proxyEnv: {
      NEON_LOCAL_PROXY: '1',
      NEON_LOCAL_PROXY_HOST: '127.0.0.1',
      NEON_LOCAL_WS_PORT: String(ws.getMappedPort(80)),
      NEON_LOCAL_HTTP_PORT: String(http.getMappedPort(4444)),
    },
    async stop() {
      for (const c of containers) await c.stop().catch(() => {})
      await network.stop().catch(() => {})
    },
  }
}

/** The real migrations, the real way (`pnpm db:migrate`, as the deploy build runs them). */
export async function migrate(directUrl: string): Promise<void> {
  await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_UNPOOLED: directUrl, DATABASE_URL: directUrl }, maxBuffer: 16 * 1024 * 1024 })
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

/** A production build of this checkout (into .next, like `pnpm build`). E2E_SKIP_BUILD=1 reuses the last one. */
export async function buildApp(): Promise<void> {
  if (process.env.E2E_SKIP_BUILD) return
  await run('pnpm', ['build'], { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 })
}

export interface App { url: string; logs(): string; stop(): void }

/** `next start` on all interfaces (the Inngest container calls back in through the Docker host gateway). */
export async function startApp(port: number, env: Record<string, string>): Promise<App> {
  // Only what the app needs: never this shell's own secrets or a stray DATABASE_URL.
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production' as const }
  const child: ChildProcess = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port), '-H', '0.0.0.0'], {
    env: { ...base, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-200_000) }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) throw new Error(`[e2e] next start exited ${child.exitCode}:\n${out.slice(-3000)}`)
    const ok = await fetch(`${url}/api/health`).then((r) => r.status < 500 || r.status === 503).catch(() => false)
    if (ok) return { url, logs: () => out, stop: () => child.kill() }
    await sleep(1000)
  }
  child.kill()
  throw new Error(`[e2e] the app never answered /api/health:\n${out.slice(-3000)}`)
}

export interface InngestDev { url: string; stop(): Promise<void> }

/** The Inngest dev server, pointed at the app on the host. */
export async function startInngest(appPort: number): Promise<InngestDev> {
  const c = await new GenericContainer(IMAGES.inngest)
    .withCommand(['inngest', 'dev', '--no-discovery', '-u', `http://host.docker.internal:${appPort}/api/inngest`])
    .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
    .withExposedPorts(8288)
    .withWaitStrategy(Wait.forHttp('/', 8288))
    .start()
  return { url: `http://127.0.0.1:${c.getMappedPort(8288)}`, stop: async () => { await c.stop().catch(() => {}) } }
}

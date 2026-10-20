import { neonConfig } from '@neondatabase/serverless'

// Point both Neon drivers at LOCAL proxies in front of a plain Postgres (the e2e stack, e2e/README.md):
// SQL-over-HTTP (`/sql`, local-neon-http-proxy) for the stateless driver and WebSocket (`/v1`, Neon's
// wsproxy) for the pooled one. The proxy address is this process's view (`localhost`); the host in
// DATABASE_URL is the proxies' view (inside the Docker network) — two different parties, so neither is
// derived from the other. Refused in production: there it would only ever be a misconfiguration.
export function configureLocalProxy(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NEON_LOCAL_PROXY !== '1') return false
  if (env.VERCEL_ENV === 'production') {
    console.warn('[baumy/db] NEON_LOCAL_PROXY is ignored in production')
    return false
  }
  const host = env.NEON_LOCAL_PROXY_HOST ?? '127.0.0.1'
  const wsPort = env.NEON_LOCAL_WS_PORT ?? '5433'
  const httpPort = env.NEON_LOCAL_HTTP_PORT ?? '4444'
  neonConfig.useSecureWebSocket = false
  neonConfig.wsProxy = () => `${host}:${wsPort}/v1`
  neonConfig.fetchEndpoint = () => `http://${host}:${httpPort}/sql`
  // The proxies speak plain TCP to Postgres; the driver must not pipeline a TLS handshake.
  neonConfig.pipelineConnect = false
  return true
}

import { describe, it, expect, afterEach } from 'vitest'
import { neonConfig } from '@neondatabase/serverless'
import { configureLocalProxy } from '../local-proxy'

// The e2e stack's local Neon proxies (db/local-proxy.ts): off by default, never in production.
const before = {
  wsProxy: neonConfig.wsProxy,
  fetchEndpoint: neonConfig.fetchEndpoint,
  useSecureWebSocket: neonConfig.useSecureWebSocket,
  pipelineConnect: neonConfig.pipelineConnect,
}
afterEach(() => Object.assign(neonConfig, before))

describe('configureLocalProxy', () => {
  it('changes nothing unless NEON_LOCAL_PROXY=1', () => {
    expect(configureLocalProxy({})).toBe(false)
    expect(neonConfig.fetchEndpoint).toBe(before.fetchEndpoint)
  })

  it('is refused in production', () => {
    expect(configureLocalProxy({ NEON_LOCAL_PROXY: '1', VERCEL_ENV: 'production' })).toBe(false)
    expect(neonConfig.wsProxy).toBe(before.wsProxy)
  })

  it('points both drivers at the local proxies', () => {
    expect(configureLocalProxy({ NEON_LOCAL_PROXY: '1', NEON_LOCAL_WS_PORT: '6001', NEON_LOCAL_HTTP_PORT: '6002' })).toBe(true)
    const ws = neonConfig.wsProxy as (host: string, port: number | string) => string
    const http = neonConfig.fetchEndpoint as (host: string, port: number | string) => string
    expect(ws('postgres', 5432)).toBe('127.0.0.1:6001/v1')
    expect(http('postgres', 5432)).toBe('http://127.0.0.1:6002/sql')
    expect(neonConfig.useSecureWebSocket).toBe(false)
    expect(neonConfig.pipelineConnect).toBe(false)
  })
})

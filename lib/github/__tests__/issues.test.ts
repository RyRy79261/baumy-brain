import { describe, it, expect, vi, afterEach } from 'vitest'
import { createIssue, issuesConfigured, labelsFor } from '@/lib/github/issues'

const savedToken = process.env.GITHUB_TOKEN
const savedRepo = process.env.GITHUB_REPO
afterEach(() => {
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = savedToken
  if (savedRepo === undefined) delete process.env.GITHUB_REPO
  else process.env.GITHUB_REPO = savedRepo
  vi.restoreAllMocks()
})

describe('github issues client', () => {
  it('issuesConfigured reflects the env', () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_REPO
    expect(issuesConfigured()).toBe(false)
    process.env.GITHUB_TOKEN = 't'
    process.env.GITHUB_REPO = 'o/r'
    expect(issuesConfigured()).toBe(true)
  })

  it('labelsFor maps type to a standard default label', () => {
    expect(labelsFor('bug')).toEqual(['bug'])
    expect(labelsFor('feature')).toEqual(['enhancement'])
  })

  it('createIssue posts and returns number + url', async () => {
    process.env.GITHUB_TOKEN = 't'
    process.env.GITHUB_REPO = 'o/r'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/o/r/issues/42' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await createIssue({ title: 't', body: 'b', labels: ['bug'] })
    expect(r).toEqual({ number: 42, url: 'https://github.com/o/r/issues/42' })
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/o/r/issues', expect.anything())
  })

  it('retries WITHOUT labels on a 422 (a missing label never loses the report)', async () => {
    process.env.GITHUB_TOKEN = 't'
    process.env.GITHUB_REPO = 'o/r'
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      return call === 1 ? new Response('bad label', { status: 422 }) : new Response(JSON.stringify({ number: 7, html_url: 'u' }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await createIssue({ title: 't', body: 'b', labels: ['nonexistent'] })
    expect(r?.number).toBe(7)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when unconfigured (feature degrades, no throw)', async () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_REPO
    expect(await createIssue({ title: 't', body: 'b' })).toBeNull()
  })
})

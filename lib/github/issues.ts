// Minimal GitHub Issues client (plain fetch — no SDK, matching lib/ai/embed.ts style).
// Lets a housemate file a bug / feature request through Baumy. OPTIONAL integration: if
// GITHUB_TOKEN + GITHUB_REPO aren't set, the feature reports itself as unconfigured and
// nothing breaks at boot. GITHUB_REPO is "owner/name" (e.g. "RyRy79261/baumy-brain"); the
// token needs issues:write on that repo.

export function issuesConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO)
}

// Standard default GitHub labels (present in every fresh repo). We stick to these so
// filing never depends on a custom label existing — and createIssue retries without
// labels anyway if the repo has had them removed.
export function labelsFor(type: 'bug' | 'feature'): string[] {
  return type === 'feature' ? ['enhancement'] : ['bug']
}

export interface NewIssue {
  title: string
  body: string
  labels?: string[]
}

async function postIssue(repo: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'baumy-brain',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// Create an issue; returns { number, url } or null on any failure (unconfigured, auth,
// rate limit, network). Never throws — the caller degrades to an apology message. If the
// repo rejects the labels (422, e.g. a default label was deleted), retry once without
// them so a label quibble never loses the report.
export async function createIssue(input: NewIssue): Promise<{ number: number; url: string } | null> {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO
  if (!token || !repo) return null
  try {
    let res = await postIssue(repo, token, { title: input.title, body: input.body, labels: input.labels ?? [] })
    if (res.status === 422 && input.labels?.length) {
      res = await postIssue(repo, token, { title: input.title, body: input.body })
    }
    if (!res.ok) {
      console.error(`createIssue: GitHub ${res.status} ${await res.text().catch(() => '')}`)
      return null
    }
    const j = (await res.json()) as { number: number; html_url: string }
    return { number: j.number, url: j.html_url }
  } catch (err) {
    console.error('createIssue: request failed:', err)
    return null
  }
}

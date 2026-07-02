import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { functions } from '@/lib/inngest/functions'

// Node.js runtime + 300s: Inngest steps run heavy AI/DB work off the request
// path. This endpoint must NOT be auth-gated (Inngest sync/callback).
export const runtime = 'nodejs'
export const maxDuration = 300

// Register against the STABLE public production URL (BAUMY_PUBLIC_URL), not the
// per-deploy `*.vercel.app` URL that Vercel Deployment Protection makes
// unreachable to Inngest. Falls back to auto-detect locally (inngest:dev).
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  serveHost: process.env.BAUMY_PUBLIC_URL || undefined,
})

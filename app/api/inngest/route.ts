import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { functions } from '@/lib/inngest/functions'

// Node.js runtime + 300s: Inngest steps run heavy AI/DB work off the request
// path. This endpoint must NOT be auth-gated (Inngest sync/callback).
export const runtime = 'nodejs'
export const maxDuration = 300

export const { GET, POST, PUT } = serve({ client: inngest, functions })

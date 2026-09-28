import { handleLoginApproval } from '@/lib/olympics/login-approval'

// Baumy Olympics "Sign in with Baumy": DM a member the sign-in approval card
// (lib/olympics/login-approval.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request): Promise<Response> {
  return handleLoginApproval(req)
}

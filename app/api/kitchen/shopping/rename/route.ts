import { handleRename } from '@/lib/lists/kitchen-api'

// Kitchen kiosk: rename one item on the house shopping list (lib/lists/kitchen-api.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request): Promise<Response> {
  return handleRename(req)
}

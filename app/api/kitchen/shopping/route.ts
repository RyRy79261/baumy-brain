import { handleList } from '@/lib/lists/kitchen-api'

// Kitchen kiosk: the house's OPEN shopping list (lib/lists/kitchen-api.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request): Promise<Response> {
  return handleList(req)
}

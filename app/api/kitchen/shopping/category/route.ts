import { handleCategory } from '@/lib/lists/kitchen-api'

// Kitchen kiosk: set a shopping item's category (issue #29, lib/lists/kitchen-api.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request): Promise<Response> {
  return handleCategory(req)
}

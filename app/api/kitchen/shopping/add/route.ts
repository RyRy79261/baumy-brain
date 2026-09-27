import { handleAdd } from '@/lib/lists/kitchen-api'

// Kitchen kiosk: add items to the house shopping list (lib/lists/kitchen-api.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request): Promise<Response> {
  return handleAdd(req)
}

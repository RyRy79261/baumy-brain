import { handleRemove } from '@/lib/lists/kitchen-api'

// Kitchen kiosk: take items off the house shopping list WITHOUT buying them (lib/lists/kitchen-api.ts). Bearer KITCHEN_API_TOKEN.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request): Promise<Response> {
  return handleRemove(req)
}

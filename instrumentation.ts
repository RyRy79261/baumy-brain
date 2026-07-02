// Next.js runs register() once on server startup.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerEnv } = await import('@/lib/env')
    assertServerEnv()
  }
}

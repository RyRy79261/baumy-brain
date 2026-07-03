// Next.js runs register() once on server startup.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerEnv } = await import('@/lib/env')
    assertServerEnv()
    // Surface a bad/typo'd BAUMY_*_MODEL id at boot rather than on the first live message.
    const { assertModelsResolvable } = await import('@/lib/ai/registry')
    try {
      assertModelsResolvable()
    } catch (err) {
      console.error('[baumy/boot] a configured model id did not resolve:', err)
    }
  }
}

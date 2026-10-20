// What an e2e test imports: the house the global setup brought up (e2e/global-setup.ts).
import { inject, afterAll } from 'vitest'
import { House, type StackInfo } from './house-driver'

export { buttons, House, type StackInfo } from './house-driver'

declare module 'vitest' {
  export interface ProvidedContext {
    stack: StackInfo
  }
}

/** The house for this test file (its database connection closes after the file). */
export function house(): House {
  const h = new House(inject('stack'))
  afterAll(() => h.close())
  return h
}

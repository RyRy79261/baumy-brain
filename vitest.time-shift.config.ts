import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

// `pnpm test:time-shift` — the suite with Date moved forward (scripts/time-shift-setup.ts). Run it when
// a change touches what "current" / "due" / "stale" means: a newly armed expiry shows up as a failure now.
export default mergeConfig(base, defineConfig({ test: { setupFiles: ['./scripts/time-shift-setup.ts'] } }))

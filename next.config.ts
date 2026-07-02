import type { NextConfig } from 'next'

// Security headers applied to every response. The webhook/inngest machine
// endpoints add their own verification; these are baseline hardening.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  // Pin file-tracing to this project (a stray lockfile in $HOME confuses the
  // auto-detected root otherwise).
  outputFileTracingRoot: import.meta.dirname,
  // Node.js runtime is required for both machine endpoints (see architecture D5);
  // never Edge — neon-serverless transactions + timing-safe crypto need Node.
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig

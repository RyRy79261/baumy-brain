// Auth constants with NO node/crypto imports — safe to import from edge
// middleware (which cannot pull in node:crypto via session.ts).
export const SESSION_COOKIE = 'baumy_session'

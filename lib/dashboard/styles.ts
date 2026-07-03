// Shared inline styles for the admin dashboard pages — hoisted so the page/table
// chrome stays identical across memory / reminders / settings (no copy-paste drift).

export const page: React.CSSProperties = { padding: '2rem', maxWidth: 760, margin: '0 auto', lineHeight: 1.5 }
export const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left' }
export const td: React.CSSProperties = { padding: '0.4rem 0.5rem', borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }

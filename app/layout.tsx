import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Baumy',
  description: "A house-management secretary for the group.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

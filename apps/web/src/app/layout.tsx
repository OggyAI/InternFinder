import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'intern finder',
  description: 'Job and internship discovery pipeline',
};

// Every page reads live database state, so nothing here may be cached at build
// time. Without this, Next would happily serve a static snapshot of the
// pipeline taken during `next build`.
export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/matches', label: 'Matches' },
  { href: '/rejections', label: 'Rejections' },
  { href: '/filters', label: 'Filters' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <span className="brand">intern finder</span>
            <nav className="main">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree, Syne } from 'next/font/google';

import { APP_NAME } from '@project-x/shared';

import { ThemeProvider } from '../components/theme-provider';
import { THEME_STORAGE_KEY } from '../lib/theme';

import './globals.css';

const display = Syne({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const body = Figtree({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: 'Project X — AI that understands the page you are on.',
  icons: {
    icon: [{ url: '/brand/mark.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/brand/mark.png' }],
  },
};

const themeBootScript = `
(function () {
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var stored = localStorage.getItem(key);
    var preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    var dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="bg-mist font-body text-ink antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

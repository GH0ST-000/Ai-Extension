/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{ts,tsx}', '!./**/node_modules/**', '!./**/build/**', '!./**/.plasmo/**'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--px-bg)',
        surface: 'var(--px-surface)',
        elevated: 'var(--px-surface-elevated)',
        primary: 'var(--px-text-primary)',
        secondary: 'var(--px-text-secondary)',
        muted: 'var(--px-text-muted)',
        border: 'var(--px-border)',
        hover: 'var(--px-hover)',
        active: 'var(--px-active)',
        accent: {
          DEFAULT: 'var(--px-accent)',
          soft: 'var(--px-accent-soft)',
        },
        kbd: {
          DEFAULT: 'var(--px-kbd-bg)',
          foreground: 'var(--px-kbd-text)',
        },
        icon: 'var(--px-icon-bg)',
      },
      boxShadow: {
        float: 'var(--px-shadow-float)',
        menu: 'var(--px-shadow-menu)',
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

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
        amber: {
          DEFAULT: 'var(--px-amber)',
          soft: 'var(--px-amber-soft)',
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
          'Avenir Next',
          'Segoe UI',
          'Helvetica Neue',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        panel: '18px',
      },
      keyframes: {
        'px-fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'px-fade-up': 'px-fade-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};

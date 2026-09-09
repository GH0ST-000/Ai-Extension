/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        ring: 'hsl(var(--ring))',
        ink: 'hsl(var(--ink))',
        mist: 'hsl(var(--mist))',
        panel: {
          DEFAULT: 'hsl(var(--panel))',
          soft: 'hsl(var(--panel-soft))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          soft: 'hsl(var(--accent-soft))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        spark: 'hsl(var(--spark))',
        line: 'hsl(var(--line))',
        inverse: {
          DEFAULT: 'hsl(var(--inverse))',
          foreground: 'hsl(var(--inverse-fg))',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: '0.875rem',
        md: '0.625rem',
        sm: '0.375rem',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        soft: 'var(--shadow-soft)',
      },
    },
  },
  plugins: [],
};

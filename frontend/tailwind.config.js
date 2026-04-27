/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Mint teal kept, but used sparingly (Linear-like restraint)
        primary: {
          50: '#f0fbfa',
          100: '#ccf3ef',
          200: '#99e7e0',
          300: '#5fd3c9',
          400: '#2bbab0',
          500: '#15b0a8',
          600: '#0d8e88',
          700: '#107e79',
          800: '#0e605d',
          900: '#0c4f4d',
        },
        // Linear-style neutrals (cool gray with slight warmth)
        ink: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
        canvas: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
        },
        finance: {
          green: '#10b981',
          red: '#ef4444',
          yellow: '#f59e0b',
          blue: '#3b82f6',
          mint: '#15b0a8',
        }
      },
      fontFamily: {
        sans: ['Inter Variable', 'Inter', 'Pretendard', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Linear-style compact scale (base ~13px)
        '2xs': ['0.6875rem', { lineHeight: '0.95rem', letterSpacing: '0.005em' }], // 11px
        xs:  ['0.75rem',   { lineHeight: '1rem',     letterSpacing: '0.005em' }], // 12px
        sm:  ['0.8125rem', { lineHeight: '1.15rem',  letterSpacing: '-0.005em' }],// 13px (default body)
        base:['0.875rem',  { lineHeight: '1.3rem',   letterSpacing: '-0.005em' }],// 14px
        lg:  ['0.9375rem', { lineHeight: '1.4rem',   letterSpacing: '-0.01em' }], // 15px
        xl:  ['1.0625rem', { lineHeight: '1.5rem',   letterSpacing: '-0.01em' }], // 17px
        '2xl': ['1.25rem', { lineHeight: '1.625rem', letterSpacing: '-0.015em' }],// 20px
        '3xl': ['1.5rem',  { lineHeight: '1.875rem', letterSpacing: '-0.02em' }], // 24px
        '4xl': ['1.875rem',{ lineHeight: '2.25rem',  letterSpacing: '-0.025em' }],// 30px
      },
      letterSpacing: {
        tightish: '-0.01em',
        crisp: '-0.015em',
      },
      boxShadow: {
        'soft': '0 1px 2px 0 rgba(0, 0, 0, 0.04)',
        'card': '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 1px 0 rgba(0, 0, 0, 0.02)',
        'pop': '0 4px 12px -2px rgba(0, 0, 0, 0.08), 0 2px 4px -1px rgba(0, 0, 0, 0.04)',
      },
      borderRadius: {
        'md': '6px',
        'lg': '8px',
        'xl': '10px',
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Clobe-inspired warm mint teal as primary
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
        // Warm canvas tones
        canvas: {
          50: '#faf9f7',
          100: '#f4f3f1',
          200: '#e9e7e3',
          300: '#d6d3cc',
        },
        cream: {
          50: '#fffdf2',
          100: '#fff5d6',
          200: '#ffe8a3',
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
        sans: ['Pretendard', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Bump the base scale ~1 step for better readability
        xs: ['0.8125rem', { lineHeight: '1.15rem' }],   // 13px
        sm: ['0.9375rem', { lineHeight: '1.4rem' }],    // 15px (default body)
        base: ['1.0625rem', { lineHeight: '1.6rem' }],  // 17px
        lg: ['1.1875rem', { lineHeight: '1.75rem' }],   // 19px
        xl: ['1.375rem', { lineHeight: '1.9rem' }],     // 22px
        '2xl': ['1.6rem', { lineHeight: '2.15rem' }],   // 25.6px
        '3xl': ['2rem', { lineHeight: '2.5rem' }],      // 32px
        '4xl': ['2.5rem', { lineHeight: '3rem' }],      // 40px
      },
      boxShadow: {
        'soft': '0 1px 3px 0 rgba(39, 43, 39, 0.04), 0 1px 2px 0 rgba(39, 43, 39, 0.06)',
        'card': '0 1px 3px 0 rgba(39, 43, 39, 0.05), 0 4px 12px -2px rgba(39, 43, 39, 0.04)',
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0B0C0F',
          900: '#101216',
          850: '#14161B',
          800: '#191C22',
          700: '#232730',
          600: '#2E333E',
        },
        accent: {
          DEFAULT: '#22C55E',
          dim: '#16A34A',
          soft: 'rgba(34,197,94,0.12)',
        },
        muted: '#8A9099',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: { '2xs': '11px' },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
        serif: ['"Instrument Serif"', 'serif'],
        sans: ['"Geist"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        syne: ['"Syne"', 'sans-serif'],
        body: ['"DM Sans"', 'sans-serif']
      },
      colors: {
        ink: {
          DEFAULT: '#0E0B08',
          2: '#2E2520',
          soft: '#7A6F68'
        },
        cream: {
          DEFAULT: '#FAF8F5',
          2: '#F3EFE8',
          3: '#E9E3D9'
        },
        burn: {
          DEFAULT: '#FF4F00',
          2: '#FF7040',
          3: '#FF9870',
          pale: '#FFF3EE',
          dim: '#FFD4BC'
        },
        gold: {
          DEFAULT: '#C49A00',
          bg: '#FFFBEA',
          border: '#EDD96A',
          deep: '#8B6D00'
        },
        leaf: {
          DEFAULT: '#1A6B35',
          bg: '#EBF5EF',
          border: '#B2DCBF'
        },
        sky: {
          DEFAULT: '#1045BB',
          bg: '#EBF0FF',
          border: '#B0C4F8'
        },
        plum: {
          DEFAULT: '#6B1FBE',
          bg: '#F2EAFF',
          border: '#D4B5F5'
        },
        teal: {
          DEFAULT: '#0B6B6B',
          bg: '#E4F4F4',
          border: '#9DD4D4'
        }
      },
      letterSpacing: {
        tightest: '-0.04em',
        hero: '-0.045em'
      },
      animation: {
        'pulse-slow': 'pulse 2.2s ease-in-out infinite',
        'fade-up': 'fadeUp 0.6s ease both'
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(18px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      }
    }
  },
  plugins: []
};

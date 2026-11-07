import type { Config } from 'tailwindcss';

/**
 * Material 3 Forest / Tonal Spot, seeded with #2e7d32 as in lyrics-android.
 * Keep the existing utility names so upstream screens inherit the theme.
 * Status palettes (red/amber/emerald) and vendor artwork keep their own colors.
 */
const neutral = {
  50: '#f7fbf1',
  100: '#f1f5eb',
  200: '#e0e4db',
  300: '#c2c9bd',
  400: '#858e80',
  500: '#626b5e',
  600: '#50594d',
  700: '#424940',
  800: '#2d342a',
  900: '#242b21',
  950: '#191d17',
};

const materialPreset = {
  theme: {
    extend: {
      colors: {
        gray: neutral,
        slate: neutral,
        blue: {
          50: '#eff9e9',
          100: '#d6e8ce',
          200: '#bcdfb2',
          300: '#a1d399',
          400: '#86b780',
          500: '#55824f',
          600: '#3c6939',
          700: '#245024',
          800: '#163e17',
          900: '#0b2f0d',
          950: '#002204',
        },
      },
      fontFamily: {
        sans: ['Roboto', 'Noto Sans', 'Noto Sans SC', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.25rem',
        '2xl': '1.5rem',
        '3xl': '1.75rem',
      },
      boxShadow: {
        sm: '0 1px 2px rgb(25 29 23 / 0.04)',
        DEFAULT: '0 1px 3px rgb(25 29 23 / 0.08), 0 2px 6px rgb(25 29 23 / 0.04)',
        md: '0 4px 12px rgb(25 29 23 / 0.06)',
        lg: '0 6px 20px rgb(25 29 23 / 0.08)',
        xl: '0 8px 28px rgb(25 29 23 / 0.12)',
        '2xl': '0 16px 48px rgb(25 29 23 / 0.16)',
      },
    },
  },
} satisfies Partial<Config>;

export default materialPreset;

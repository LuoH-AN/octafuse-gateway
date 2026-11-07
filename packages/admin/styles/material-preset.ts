import type { Config } from 'tailwindcss';

/**
 * Material 3 with a monochrome primary and neutral surfaces.
 * Keep the existing utility names so upstream screens inherit the theme.
 * Keep semantic error/warning/success colors available to operational screens.
 */
const neutral = {
  50: '#fafafa',
  100: '#f3f3f3',
  200: '#e7e7e7',
  300: '#d1d1d1',
  400: '#929292',
  500: '#707070',
  600: '#555555',
  700: '#414141',
  800: '#303030',
  900: '#202020',
  950: '#141414',
};

const primary = { ...neutral, 500: '#404040', 600: '#202020', 700: '#0a0a0a', 800: '#080808', 900: '#050505', 950: '#000000' };

const materialPreset = {
  theme: {
    extend: {
      colors: {
        gray: neutral,
        slate: neutral,
        blue: primary,
        indigo: primary,
        violet: primary,
        purple: primary,
        sky: primary,
        cyan: primary,
        teal: primary,
      },
      fontFamily: {
        sans: ['Roboto', 'Noto Sans', 'Noto Sans SC', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '0.875rem',
        xl: '1rem',
        '2xl': '1.5rem',
        '3xl': '1.75rem',
      },
      boxShadow: {
        sm: '0 1px 2px rgb(0 0 0 / 0.025)',
        DEFAULT: '0 1px 3px rgb(0 0 0 / 0.06), 0 2px 6px rgb(0 0 0 / 0.03)',
        md: '0 4px 12px rgb(0 0 0 / 0.05)',
        lg: '0 6px 20px rgb(0 0 0 / 0.07)',
        xl: '0 8px 28px rgb(0 0 0 / 0.1)',
        '2xl': '0 16px 48px rgb(0 0 0 / 0.14)',
      },
    },
  },
} satisfies Partial<Config>;

export default materialPreset;

/**
 * Tailwind：页面扫描范围与独立 Material 主题预设。
 */
import type { Config } from "tailwindcss";
import materialPreset from './styles/material-preset';

const config: Config = {
  presets: [materialPreset],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;

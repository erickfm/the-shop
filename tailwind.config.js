/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(15 17 23)",
        surface: "rgb(22 25 33)",
        border: "rgb(40 45 58)",
        accent: "rgb(99 130 255)",
        accentdim: "rgb(60 80 180)",
        muted: "rgb(140 148 168)",
        danger: "rgb(231 102 102)",
        ok: "rgb(116 196 138)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Inter", "sans-serif"],
        mono: ["ui-monospace", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

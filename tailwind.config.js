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
        // Warm pop for serif-italic display headings — gives the wordmark
        // and section titles a hand-set / boutique tone against the cool-gray
        // body sans.
        marquee: "rgb(231 196 128)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Inter", "sans-serif"],
        mono: ["ui-monospace", "JetBrains Mono", "monospace"],
        // Italic-leaning serif for display copy. Georgia is widely available
        // and reads as "magazine / boutique" without needing a webfont.
        display: ["Georgia", "Times New Roman", "serif"],
      },
    },
  },
  plugins: [],
};

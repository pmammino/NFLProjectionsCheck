import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ceiling: "#16a34a",
        floor: "#dc2626",
        median: "#2563eb",
      },
    },
  },
  plugins: [],
};
export default config;

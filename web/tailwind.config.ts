import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Canvas + 4-step graphite surface scale
        canvas: "#0A0B0D",
        surface: {
          0: "#101216",
          1: "#16191F",
          2: "#1D2127",
          3: "#262B33",
        },
        border: "#2A2F38",
        hairline: "#2A2F38",
        // One rationed accent — signal-cyan
        accent: {
          DEFAULT: "#4ED8C4",
          bright: "#7FF0E0",
        },
        // Fixed tier ramp
        tier: {
          active: "#4ED8C4",
          dormant: "#E0A458",
          archived: "#5B6470",
          pruned: "#5B6470",
        },
        // Event-verb hues (muted)
        event: {
          formed: "#4ED8C4",
          reinforced: "#5FB87A",
          contradicted: "#D86A6A",
          superseded: "#D86A6A",
          merged: "#9B7FD8",
          demoted: "#E0A458",
          promoted: "#7FF0E0",
          pruned: "#5B6470",
        },
        ink: {
          DEFAULT: "#E6E9EE",
          dim: "#9AA3AF",
          faint: "#5B6470",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: [
          "var(--font-jetbrains)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "0.9rem" }],
      },
    },
  },
  plugins: [],
};

export default config;

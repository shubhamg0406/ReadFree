// Centralized ReadFree design tokens — kept outside /app so it's not a route.
export type ThemeMode = "light" | "dark";

export const palette = {
  light: {
    background: "#F9F8F6",
    surface: "#FFFFFF",
    textPrimary: "#121212",
    textSecondary: "#5C5C5C",
    border: "#E5E5E5",
    brand: "#000000",
    brandText: "#FFFFFF",
    error: "#D32F2F",
    inputBg: "#FFFFFF",
  },
  dark: {
    background: "#0C0C0C",
    surface: "#1A1A1A",
    textPrimary: "#EAEAEA",
    textSecondary: "#A3A3A3",
    border: "#2E2E2E",
    brand: "#FFFFFF",
    brandText: "#000000",
    error: "#FF6B6B",
    inputBg: "#1A1A1A",
  },
} as const;

export const spacing = {
  unit: 8,
  screenH: 24,
  readerH: 20,
  element: 16,
};

export const radius = { sm: 2, md: 4, lg: 8, button: 4 };

export const type = {
  h1: { fontSize: 32, lineHeight: 40, fontWeight: "700" as const, letterSpacing: -1, fontFamily: "sans-serif" },
  h2: { fontSize: 26, lineHeight: 34, fontWeight: "700" as const, letterSpacing: -0.5, fontFamily: "serif" },
  bodyReader: { fontSize: 18, lineHeight: 28, fontWeight: "400" as const, fontFamily: "serif" },
  bodyUi: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const, fontFamily: "sans-serif" },
  caption: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600" as const,
    letterSpacing: 1.5,
    fontFamily: "sans-serif",
  },
};

export function colorsFor(mode: ThemeMode) {
  return palette[mode];
}

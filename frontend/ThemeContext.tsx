import React, { createContext, useContext, useMemo, useState, useCallback } from "react";
import { useColorScheme } from "react-native";
import { ThemeMode, colorsFor } from "./theme";

type Ctx = {
  mode: ThemeMode;
  colors: ReturnType<typeof colorsFor>;
  toggle: () => void;
};

const ThemeCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>(system === "light" ? "light" : "dark");

  const toggle = useCallback(() => {
    setMode((m) => (m === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ mode, colors: colorsFor(mode), toggle }),
    [mode]
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

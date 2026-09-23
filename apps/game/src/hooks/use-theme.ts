import { useCallback, useEffect, useState } from "react"

type Theme = "light" | "dark"

const STORAGE_KEY = "theme"

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark") return stored
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.setAttribute("data-theme", theme)
  // tokens.css switches its color-role variables via the [data-theme]
  // attribute selector above. shadcn/Base UI components additionally use
  // Tailwind's `dark:` variant, which this project's globals.css configures
  // to key off a `.dark` class (`@custom-variant dark (&:is(.dark *));`) —
  // both must be kept in sync or component-level dark: overrides silently
  // stop applying even though the token colors still swap correctly.
  root.classList.toggle("dark", theme === "dark")
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark")
  }, [theme, setTheme])

  return { theme, setTheme, toggleTheme }
}

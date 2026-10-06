import { useEffect, useLayoutEffect, useState } from 'react'

/** The colours a user picks. Everything else (borders, hovers, selection…) is derived from these. */
export interface ThemeColors {
  library: string
  sheets: string
  editor: string
  text: string
  textSoft: string
  textMuted: string
  accent: string
}

export type ColorSlot = keyof ThemeColors

export const SLOTS: { group: string; slots: { key: ColorSlot; label: string }[] }[] = [
  {
    group: 'Backgrounds',
    slots: [
      { key: 'library', label: 'Library' },
      { key: 'sheets', label: 'Sheet List' },
      { key: 'editor', label: 'Editor' }
    ]
  },
  {
    group: 'Text',
    slots: [
      { key: 'text', label: 'Text' },
      { key: 'textSoft', label: 'Secondary' },
      { key: 'textMuted', label: 'Muted' },
      { key: 'accent', label: 'Accent' }
    ]
  }
]

/** Mirrors the built-in light and dark values in styles.css — sand, shell blue and eye navy from the icon. */
const LIGHT: ThemeColors = {
  library: '#ece0cb',
  sheets: '#f3e9d7',
  editor: '#faf5ec',
  text: '#1c2231',
  textSoft: '#4a4f5c',
  textMuted: '#8a8274',
  accent: '#0a6fd6'
}

const DARK: ThemeColors = {
  library: '#0f1622',
  sheets: '#131b29',
  editor: '#172131',
  text: '#ece4d6',
  textSoft: '#bcb5a8',
  textMuted: '#7d8799',
  accent: '#4ba3f7'
}

export const PRESETS = {
  light: { name: 'Light', colors: LIGHT },
  dark: { name: 'Dark', colors: DARK },
  sepia: {
    name: 'Sepia',
    colors: {
      library: '#e9dfc9',
      sheets: '#f1e8d4',
      editor: '#f7f0df',
      text: '#3b2f22',
      textSoft: '#5e4d3a',
      textMuted: '#94826b',
      accent: '#b0603a'
    }
  },
  rose: {
    name: 'Rosé',
    colors: {
      library: '#f1e6e6',
      sheets: '#f8eeee',
      editor: '#fdf6f5',
      text: '#2e2226',
      textSoft: '#5a464c',
      textMuted: '#9a8389',
      accent: '#c4527a'
    }
  },
  midnight: {
    name: 'Midnight',
    colors: {
      library: '#10141f',
      sheets: '#151b29',
      editor: '#1a2133',
      text: '#dde3f0',
      textSoft: '#a8b2c8',
      textMuted: '#6c7891',
      accent: '#7aa2f7'
    }
  },
  forest: {
    name: 'Forest',
    colors: {
      library: '#1a211c',
      sheets: '#1f2721',
      editor: '#242d27',
      text: '#e3e9e1',
      textSoft: '#b4c0b2',
      textMuted: '#7c8a7a',
      accent: '#8fbf7a'
    }
  }
} satisfies Record<string, { name: string; colors: ThemeColors }>

export type PresetId = keyof typeof PRESETS
export type ThemeId = 'system' | 'custom' | PresetId

/** Rows of ready-made colours offered for every slot: paper tones, mid greys, darks, then accents for each. */
export const PALETTE: string[][] = [
  ['#ffffff', '#faf5ec', '#f7f0df', '#f3e9d7', '#ece0cb', '#e9dfc9', '#f8eeee', '#eef2f7'],
  ['#d4d4d8', '#bcb5a8', '#a8b2c8', '#8a8274', '#7d8799', '#6c7891', '#5e4d3a', '#4a4f5c'],
  ['#3b2f22', '#2e2226', '#252528', '#242d27', '#172131', '#1a2133', '#0f1622', '#0f0f10'],
  ['#0a6fd6', '#0891b2', '#7c3aed', '#c4527a', '#dc2626', '#f26b12', '#ca8a04', '#16a34a'],
  ['#4ba3f7', '#7aa2f7', '#c4a7f5', '#f48fb1', '#f87171', '#ff9a4d', '#facc15', '#8fbf7a']
]

export interface ThemeSettings {
  id: ThemeId
  /** The user's own theme. Editing any colour while on a preset copies the preset here. */
  custom: ThemeColors
  /** Colours the user has saved for reuse across slots. */
  swatches: string[]
}

const DEFAULT_THEME: ThemeSettings = { id: 'system', custom: LIGHT, swatches: [] }
const THEME_KEY = 'hermit:theme'

// ── Colour maths ────────────────────────────────────────────────────────────

/** Normalise `#rgb` / `#rrggbb` (with or without `#`) to lowercase `#rrggbb`, or null if invalid. */
export function normalizeHex(value: string): string | null {
  const raw = value.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map((c) => c + c).join('')}`
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const isDark = (hex: string, threshold = 0.2) => luminance(hex) < threshold

// ── Applying ────────────────────────────────────────────────────────────────

export function resolveColors(theme: ThemeSettings, systemDark: boolean): ThemeColors {
  if (theme.id === 'custom') return theme.custom
  if (theme.id === 'system') return systemDark ? DARK : LIGHT
  return PRESETS[theme.id].colors
}

/** CSS custom properties for a set of colours. Code and search colours follow the editor's lightness. */
function themeVariables(c: ThemeColors): Record<string, string> {
  const dark = isDark(c.editor)
  const tint = (pct: number) => `color-mix(in srgb, ${c.text} ${pct}%, transparent)`
  return {
    'color-scheme': dark ? 'dark' : 'light',
    '--bg-library': c.library,
    '--bg-sheets': c.sheets,
    '--bg-editor': c.editor,
    '--bg-hover': tint(dark ? 5 : 4.5),
    '--bg-active': tint(dark ? 9 : 7.5),
    '--border': tint(7),
    '--border-strong': tint(dark ? 15 : 14),
    '--text': c.text,
    '--text-soft': c.textSoft,
    '--text-muted': c.textMuted,
    '--md-mark': `color-mix(in srgb, ${c.textMuted} 55%, ${c.editor})`,
    '--accent': c.accent,
    // Biased towards white so mid-tone accents (like the default blue) keep white labels.
    '--accent-text': isDark(c.accent, 0.3) ? '#ffffff' : '#0b1a1f',
    '--selection': `color-mix(in srgb, ${c.accent} ${dark ? 25 : 18}%, transparent)`,
    '--code': dark ? '#ff9a4d' : '#b8480a',
    '--search-match': dark ? 'rgba(250, 204, 21, 0.25)' : 'rgba(250, 204, 21, 0.35)',
    '--search-match-active': dark ? 'rgba(250, 160, 21, 0.5)' : 'rgba(250, 160, 21, 0.6)',
    '--syn-keyword': dark ? '#c792ea' : '#8b3fbf',
    '--syn-number': dark ? '#f0a35e' : '#b45309',
    '--syn-def': dark ? '#5fd1e8' : '#0e7490'
  }
}

let applied: string[] = []

/** Override the stylesheet's colours on :root, or clear the overrides to follow the system. */
function applyTheme(theme: ThemeSettings): void {
  const style = document.documentElement.style
  for (const name of applied) style.removeProperty(name)
  applied = []
  if (theme.id === 'system') return
  for (const [name, value] of Object.entries(themeVariables(resolveColors(theme, false)))) {
    style.setProperty(name, value)
    applied.push(name)
  }
}

function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (!raw) return DEFAULT_THEME
    const saved = JSON.parse(raw) as Partial<ThemeSettings>
    const id = saved.id && (saved.id === 'system' || saved.id === 'custom' || saved.id in PRESETS) ? saved.id : 'system'
    return {
      id,
      custom: { ...LIGHT, ...saved.custom },
      swatches: Array.isArray(saved.swatches) ? saved.swatches : []
    }
  } catch {
    return DEFAULT_THEME
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => darkQuery().matches)
  useEffect(() => {
    const query = darkQuery()
    const update = () => setDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark
}

/** The persisted theme, applied to the document before paint. */
export function useTheme() {
  const [theme, setTheme] = useState(loadTheme)
  useLayoutEffect(() => applyTheme(theme), [theme])
  useEffect(() => localStorage.setItem(THEME_KEY, JSON.stringify(theme)), [theme])
  return [theme, setTheme] as const
}

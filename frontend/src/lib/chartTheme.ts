import { useThemeStore } from '@/store/themeStore'

/**
 * Theme-aware colors for Recharts axes/grid/labels/tooltips.
 * Categorical series colors (brand hex per channel, status colors, etc.)
 * are intentionally NOT included here — those stay constant across themes.
 */
export interface ChartTheme {
  /** Axis tick label color (XAxis/YAxis `tick.fill`) */
  axisColor: string
  /** CartesianGrid stroke */
  gridColor: string
  /** Primary label/annotation text (custom SVG <text>, pie labels) */
  labelColor: string
  /** Secondary/muted label text (sub-labels, percentages) */
  mutedLabelColor: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
}

const LIGHT_CHART_THEME: ChartTheme = {
  axisColor: '#9ca3af',
  gridColor: '#e5e7eb',
  labelColor: '#374151',
  mutedLabelColor: '#6b7280',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e5e7eb',
  tooltipText: '#18181b',
}

const DARK_CHART_THEME: ChartTheme = {
  axisColor: '#8A8F98',
  gridColor: '#2A2D33',
  labelColor: '#C9CED6',
  mutedLabelColor: '#9BA1AC',
  tooltipBg: '#18181b',
  tooltipBorder: '#2A2D33',
  tooltipText: '#fafafa',
}

export function getChartTheme(isDark: boolean): ChartTheme {
  return isDark ? DARK_CHART_THEME : LIGHT_CHART_THEME
}

/** React hook — subscribes to the theme store so charts re-render on toggle. */
export function useChartTheme(): ChartTheme {
  const theme = useThemeStore((s) => s.theme)
  return getChartTheme(theme === 'dark')
}

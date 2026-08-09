/**
 * Design tokens for the Upande Sensors app.
 *
 * Both modes are *selected*, not flipped: the dark column is the same hue set
 * re-stepped for the dark surface, so a series keeps its identity across themes
 * while staying above the contrast floor on whichever surface it lands on.
 */

const categoricalLight = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948', // 8 red
];

const categoricalDark = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];

// Status is fixed across modes and never doubles as a series colour. Every
// status is rendered with a label beside it, so hue never carries meaning alone.
const status = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

const light = {
  mode: 'light',
  background: '#f2f1ed',
  surface: '#fcfcfb',
  surfaceSunken: '#e9e7e2',
  border: '#dfdcd5',
  borderStrong: '#c9c5bc',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  textMuted: '#84827b',
  accent: '#2a78d6',
  accentSoft: '#e6f0fc',
  onAccent: '#ffffff',
  grid: '#e5e3de',
  series: categoricalLight,
  status,
  // Sequential blue ramp, light -> dark. Used for magnitude, never identity.
  sequential: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#256abf', '#184f95'],
};

const dark = {
  mode: 'dark',
  background: '#111110',
  surface: '#1a1a19',
  surfaceSunken: '#232322',
  border: '#33322f',
  borderStrong: '#4a4945',
  textPrimary: '#ffffff',
  textSecondary: '#c3c2b7',
  textMuted: '#8e8d84',
  accent: '#3987e5',
  accentSoft: '#16283d',
  onAccent: '#ffffff',
  grid: '#2b2b28',
  series: categoricalDark,
  status,
  sequential: ['#184f95', '#256abf', '#2a78d6', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 22,
  pill: 999,
};

/**
 * Poppins weight -> family name.
 *
 * Android ignores `fontWeight` on a custom font: every weight is a separate
 * font file, so the family has to change instead. Anywhere a weight is set,
 * the matching family must be set with it or the text silently falls back to
 * Regular (or a synthesised fake-bold).
 */
export const FONTS = {
  400: 'Poppins_400Regular',
  500: 'Poppins_500Medium',
  600: 'Poppins_600SemiBold',
  700: 'Poppins_700Bold',
};

/** Family for a weight, tolerant of numbers and strings. */
export function font(weight = '400') {
  return FONTS[String(weight)] || FONTS[400];
}

export const type = {
  display: { fontSize: 30, fontWeight: '700', fontFamily: font('700'), letterSpacing: -0.5 },
  title: { fontSize: 20, fontWeight: '700', fontFamily: font('700'), letterSpacing: -0.3 },
  heading: { fontSize: 16, fontWeight: '600', fontFamily: font('600') },
  body: { fontSize: 14, fontWeight: '400', fontFamily: font('400') },
  label: { fontSize: 12, fontWeight: '600', fontFamily: font('600'), letterSpacing: 0.3 },
  caption: { fontSize: 11, fontWeight: '500', fontFamily: font('500') },
  mono: { fontSize: 12, fontFamily: FONTS[400], fontVariant: ['tabular-nums'] },
};

export function getTheme(scheme) {
  return scheme === 'dark' ? dark : light;
}

export { light, dark };

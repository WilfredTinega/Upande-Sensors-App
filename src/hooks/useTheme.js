import { getTheme, spacing, radius, type } from '../theme';
import { useThemePreference } from '../context/ThemeContext';

/**
 * The active palette.
 *
 * Reads the app's appearance preference rather than the OS directly, so an
 * explicit Light or Dark choice wins over the system setting. Falls back to the
 * light palette if called outside the provider.
 */
export function useTheme() {
  const preference = useThemePreference();
  return preference?.theme || getTheme('light');
}

export { spacing, radius, type };

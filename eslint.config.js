// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', 'node_modules/*'],
  },
  {
    /**
     * The React Compiler's lints, as warnings rather than errors.
     *
     * `eslint-config-expo` 57 brought `eslint-plugin-react-hooks` 7, whose new
     * rules exist to keep code compilable by the React Compiler. This app does
     * not run the compiler (no `experiments.reactCompiler`), and the idioms the
     * rules object to are the ones React Native's own Animated documentation
     * prescribes — `useRef(new Animated.Value(0)).current` is flagged as "refs
     * during render" at every animated component in the tree — plus the
     * `setState` inside an effect that a subscribe-then-sync pattern needs.
     * Forty-odd such sites predate the upgrade. They are worth revisiting the
     * day the compiler is switched on, and worth seeing until then, which is
     * what a warning is for; failing every lint run on them tells nobody
     * anything new.
     */
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
]);

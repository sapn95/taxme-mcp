// Flat ESLint config. Modern JS defaults everywhere, plus the two rules that
// matter for an MCP server specifically: stdout belongs to the protocol, and a
// swallowed error must be swallowed on purpose.
import js from '@eslint/js';
import globals from 'globals';

const modern = {
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  'prefer-arrow-callback': 'error',
  'object-shorthand': ['error', 'properties'],
  'no-throw-literal': 'error',
  'no-promise-executor-return': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all' }],
  // `catch { /* best-effort */ }` is a deliberate idiom here — every other kind
  // of empty block is still a mistake.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-await-in-loop': 'off',   // the portal is a state machine: the loops are sequential on purpose
};

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['index.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Both worlds: the server runs in Node, but the page callbacks handed to
      // Playwright's evaluate() run in the browser and use document/window.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...modern,
      // stdout is the MCP transport. A stray console.log corrupts the stream
      // and the client sees a protocol error instead of a result.
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: modern,
  },
];

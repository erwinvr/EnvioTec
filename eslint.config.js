import js from '@eslint/js';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import security from 'eslint-plugin-security';

const sharedGlobals = {
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
  AbortSignal: 'readonly', fetch: 'readonly', structuredClone: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', queueMicrotask: 'readonly',
};
const nodeGlobals = { ...sharedGlobals, process: 'readonly', Buffer: 'readonly' };
const browserGlobals = {
  ...sharedGlobals, window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', HTMLElement: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', FormData: 'readonly', Intl: 'readonly',
};

export default [
  {
    ignores: ['**/node_modules/**', '**/coverage/**', 'spikes/**/out/**', 'secrets/**', '.check-secrets/**'],
  },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['backend/**/*.js', 'spikes/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: nodeGlobals },
    ...security.configs.recommended,
    rules: {
      ...security.configs.recommended.rules,
      // Very high false-positive rate with ordinary map lookups. Mass
      // assignment is controlled with schemas (additionalProperties: false).
      'security/detect-object-injection': 'off',
      // File paths come from the deployment configuration (Docker secrets)
      // or from test fixtures, never from user input.
      'security/detect-non-literal-fs-filename': 'off',
      'no-console': ['error', { allow: ['error', 'log'] }],
    },
  },
  {
    files: ['frontend/**/*.js'],
    languageOptions: { globals: browserGlobals },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      // HTML sinks are forbidden in the frontend even with static strings (A9).
      'no-restricted-properties': ['error',
        { property: 'innerHTML', message: 'Use textContent o el helper de DOM.' },
        { property: 'outerHTML', message: 'Use textContent o el helper de DOM.' },
        { property: 'insertAdjacentHTML', message: 'Cree nodos con el helper de DOM.' },
        { property: 'srcdoc', message: 'La vista previa usa iframe sandbox con src (ADR-012).' },
        { object: 'document', property: 'write', message: 'Prohibido (A9).' },
        { object: 'document', property: 'writeln', message: 'Prohibido (A9).' },
      ],
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: 'No guarde datos de sesión en el navegador (A5).' },
        { name: 'sessionStorage', message: 'No guarde datos de sesión en el navegador (A5).' },
      ],
      'no-console': 'error',
    },
  },
];

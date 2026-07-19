// Correctness-only lint: catch unused imports, undefined globals, and dead
// code. No style rules — formatting is left alone.

import js from '@eslint/js';

// Globals available in the Cloudflare Workers runtime (src) and Node 22
// (tests, scripts) — the union is fine since both are server-side JS.
const RUNTIME_GLOBALS = {
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortController: 'readonly',
  crypto: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  Buffer: 'readonly',
  process: 'readonly',
  globalThis: 'readonly'
};

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: RUNTIME_GLOBALS
    },
    rules: {
      // The codebase deliberately uses `catch {}` for degrade-to-null paths.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  }
];

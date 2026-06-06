// eslint.config.js — flat config (ESLint 9)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'lib/**',
      'coverage/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Honor the conventional underscore prefix for intentionally-unused
      // bindings (e.g. destructuring skips, unused optional params).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
);

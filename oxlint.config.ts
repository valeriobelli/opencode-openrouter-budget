import { defineConfig } from 'oxlint'

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  jsPlugins: ['@stylistic/eslint-plugin'],
  categories: {
    correctness: 'error',
    perf: 'error',
  },
  options: {
    typeAware: true,
  },
  env: {
    builtin: true,
  },
  rules: {
    '@stylistic/padding-line-between-statements': [
      'error',
      { blankLine: 'always', next: 'return', prev: '*' },
      { blankLine: 'always', next: '*', prev: ['const', 'let'] },
      { blankLine: 'any', next: ['const', 'let'], prev: ['const', 'let'] },
      { blankLine: 'always', next: ['multiline-expression', 'block-like'], prev: '*' },
      { blankLine: 'always', next: '*', prev: 'block-like' },
    ],
  },
})

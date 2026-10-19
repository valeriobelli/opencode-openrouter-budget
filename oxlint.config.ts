import { defineConfig } from 'oxlint'

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
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
})

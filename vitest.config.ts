import { defineConfig } from 'vitest/config'

// MangoQA — configuration Vitest.
// - Environment node (zéro DOM, les tests accèdent à fs/os).
// - Tous les tests vivent sous tests/unit/ (test-*.ts), au format vitest
//   (describe/it/expect) — aucune exclusion nominative n'est plus nécessaire.
// - Coverage sur le code de production sous src/**.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/test-*.ts',
    ],
    exclude: [
      '**/node_modules/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
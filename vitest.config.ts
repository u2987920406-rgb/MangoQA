import { defineConfig } from 'vitest/config'

// MangoQA — configuration Vitest.
// - Environment node (zéro DOM, les tests accèdent à fs/os).
// - Inclut les tests maison à la racine (test-*.ts) ET les tests vitest dans src/.
// - Coverage sur le code de production sous src/**, en excluant les fichiers de test.
export default defineConfig({
  test: {
    environment: 'node',
    // Les tests vitest vivent dans src/. Les tests maison (test-*.ts à la
    // racine) utilisent un framework check() manuel — ils restent exécutables
    // via `npm run test:manual` et sont exclus de vitest.
    include: [
      'src/**/test-*.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/test-*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
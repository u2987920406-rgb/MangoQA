import { defineConfig } from 'vitest/config'

// MangoQA — configuration Vitest.
// - Environment node (zéro DOM, les tests accèdent à fs/os).
// - Inclut les tests maison à la racine (test-*.ts) ET les tests vitest dans src/.
// - Coverage sur le code de production sous src/**, en excluant les fichiers de test.
export default defineConfig({
  test: {
    environment: 'node',
    // Les tests vitest vivent dans src/. Les tests maison (test-*.ts à la
    // racine ET ces 5 fichiers sous src/, antérieurs à la migration vitest)
    // utilisent un framework check() manuel (zéro describe/it) — ils restent
    // exécutables via `npm run test:manual` et sont exclus de vitest (sinon
    // vitest les charge comme suites et échoue : "No test suite found in file").
    include: [
      'src/**/test-*.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'src/test-jsonl.ts',
      'src/test-orchestrator.ts',
      'src/test-fs-shared.ts',
      'src/test-observer.ts',
      'src/test-observer-runner.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/test-*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
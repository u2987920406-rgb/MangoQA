// Garde-fous de PACKAGING (J3). Déterministe, zéro réseau.
//
// Ces règles ne se voient pas en développement — elles ne cassent qu'À L'INSTALLATION,
// chez quelqu'un d'autre, souvent en silence. C'est la pire catégorie de défaut pour un
// outil dont la promesse est de ne pas se taire, d'où ces tests.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(path.join(racine, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}
const cliSource = readFileSync(path.join(racine, 'src/cli.ts'), 'utf8')
const mcpSource = readFileSync(path.join(racine, 'src/mcp.ts'), 'utf8')

/** Les paquets lourds, mesurés le 2026-08-05 sur une installation propre : 280 Mo
 *  pour le SDK Claude (le cerveau de REPLI), 50 Mo pour les grammaires WASM
 *  (l'Auditeur de Flux, que la CLI n'appelle jamais), ~16 Mo pour le SDK MCP et ses
 *  dépendances (express, hono, zod, ajv — le serveur MCP seulement). Aucun n'est
 *  nécessaire pour auditer un dossier depuis un terminal. */
const LOURDS = [
  '@anthropic-ai/claude-agent-sdk',
  'web-tree-sitter',
  'tree-sitter-wasms',
  '@modelcontextprotocol/sdk',
  'zod',
]

describe('packaging de la CLI', () => {
  it('les binaires pointent sur le build, pas sur la source TypeScript', () => {
    expect(pkg.bin?.mangoqa).toBe('./dist/cli.js')
    expect(pkg.bin?.['mangoqa-mcp']).toBe('./dist/mcp.js')
  })

  it('le paquet ne livre que dist/ et le README — ni corpus, ni harnais de mesure', () => {
    expect(pkg.files).toEqual(['dist', 'README.md'])
  })

  it('les deux points d\'entrée portent un shebang, sinon les binaires installés ne sont pas exécutables', () => {
    expect(cliSource.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(mcpSource.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  // Le piège qui a motivé ce fichier : l'ancien garde testait `/cli\.(ts|js)$/` sur
  // process.argv[1]. `npm i -g` installe un lien nommé « mangoqa » — le motif ne
  // correspondait plus, et la commande se terminait en SILENCE, code 0, sans rien
  // auditer. Invisible en développement, fatal à l'installation.
  it('le point d\'entrée se détecte par URL de module, jamais par le NOM du fichier', () => {
    for (const source of [cliSource, mcpSource]) {
      expect(source).toContain('import.meta.url === pathToFileURL(realpathSync(entree)).href')
    }
    expect(cliSource).not.toMatch(/argv\[1\]\)?\s*\)?\s*&&\s*\/cli\\?\./)
  })

  it('les 353 Mo de dépendances lourdes ne sont PAS des dependencies', () => {
    for (const nom of LOURDS) {
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain(nom)
    }
  })

  it('… elles sont des peerDependencies déclarées OPTIONNELLES (donc non installées)', () => {
    for (const nom of LOURDS) {
      expect(pkg.peerDependencies?.[nom]).toBeDefined()
      expect(pkg.peerDependenciesMeta?.[nom]?.optional).toBe(true)
    }
  })

  it('… et restent en devDependencies : le dépôt lui-même doit rester complet', () => {
    for (const nom of LOURDS) {
      expect(pkg.devDependencies?.[nom]).toBeDefined()
    }
  })

  it('une dépendance optionnelle n\'est JAMAIS importée statiquement (sinon le module entier casse)', () => {
    const llm = readFileSync(path.join(racine, 'src/llm.ts'), 'utf8')
    const parser = readFileSync(path.join(racine, 'src/flux-eye/parser.ts'), 'utf8')
    // `import type` est effacé à la compilation — autorisé. Un import de VALEUR ne l'est pas.
    expect(llm).toContain("import type { query as QueryFn } from '@anthropic-ai/claude-agent-sdk'")
    expect(llm).not.toMatch(/^import \{ query \} from '@anthropic-ai\/claude-agent-sdk'/m)
    expect(llm).toContain("await import('@anthropic-ai/claude-agent-sdk')")
    expect(parser).toContain("import type Parser from 'web-tree-sitter'")
    expect(parser).not.toMatch(/^import Parser from 'web-tree-sitter'/m)
    expect(parser).toContain("await import('web-tree-sitter')")
    // Le serveur MCP : aucun import statique du SDK ni de zod, sinon `mangoqa`
    // (la CLI) traînerait 16 Mo pour une fonctionnalité qu'elle n'utilise pas.
    expect(mcpSource).not.toMatch(/^import .* from '@modelcontextprotocol\/sdk/m)
    expect(mcpSource).not.toMatch(/^import .* from 'zod'/m)
    expect(mcpSource).toContain("import('@modelcontextprotocol/sdk/server/mcp.js')")
  })

  it('auditProject n\'importe PAS via orchestrator.js — c\'est ce qui garde la CLI légère', () => {
    const audit = readFileSync(path.join(racine, 'src/audit.ts'), 'utf8')
    // Passer par l'orchestrateur ré-introduirait design-eye, suite-eye, retex et
    // flux-eye/parser dans le graphe de la CLI, donc les 50 Mo de WASM.
    expect(audit).toContain("from './project-files.js'")
    expect(audit).not.toContain("from './orchestrator.js'")
  })
})

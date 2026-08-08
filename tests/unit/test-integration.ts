// Lot 5 (ADR-001) — l'intégration : de zéro à un premier verdict en une commande.
//
// Critère d'achèvement : *« un utilisateur passe de zéro à un premier verdict en une
// commande. »*
//
// Mais le vrai risque de ce lot n'est pas là. Il est dans ce qu'une installation
// **détruit** en s'installant : un `.mcp.json` qui contient déjà trois serveurs, un
// `pre-push` qui lance déjà des tests, ce sont des heures de réglage. Un outil qui les
// remplace en silence pour s'installer plus vite est un outil qu'on désinstalle.
//
// La moitié de ce fichier gèle donc des REFUS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  fusionnerMcpConfig,
  planifierHook,
  contenuHookPrePush,
  contenuWorkflowCi,
  estNotreHook,
  MARQUEUR_HOOK,
  CHEMIN_WORKFLOW,
} from '../../src/integration.js'
import { parseArgs, executerInstallation, type CommandeInstallation } from '../../src/cli.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── `.mcp.json` : fusionner, jamais écraser ─────────────────────────────────

describe('fusionnerMcpConfig', () => {
  it('fichier absent → créé avec notre seul serveur', () => {
    const r = fusionnerMcpConfig(null)
    expect(r.etat).toBe('ecrit')
    expect(JSON.parse(r.contenu).mcpServers.mangoqa.command).toBe('npx')
  })

  it('CONSERVE les serveurs déjà configurés', () => {
    // Le test qui compte. Perdre la configuration d'un autre outil en s'installant,
    // c'est se faire retirer dans l'heure.
    const existant = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' }, autre: { command: 'x' } } })
    const r = fusionnerMcpConfig(existant)
    expect(r.etat).toBe('fusionne')
    const apres = JSON.parse(r.contenu)
    expect(Object.keys(apres.mcpServers).sort()).toEqual(['autre', 'github', 'mangoqa'])
    expect(apres.mcpServers.github.command).toBe('gh-mcp')
  })

  it('conserve aussi les clés de premier niveau qu\'on ne connaît pas', () => {
    const r = fusionnerMcpConfig(JSON.stringify({ $schema: 'x', inputs: [1], mcpServers: {} }))
    const apres = JSON.parse(r.contenu)
    expect(apres.$schema).toBe('x')
    expect(apres.inputs).toEqual([1])
  })

  it('déjà présent à l\'identique → inchangé (installation idempotente)', () => {
    const premier = fusionnerMcpConfig(null)
    expect(fusionnerMcpConfig(premier.contenu).etat).toBe('inchange')
  })

  it('une entrée « mangoqa » DIFFÉRENTE est un réglage volontaire : on la laisse', () => {
    // Un chemin local, un modèle imposé… quelqu'un a pris cette décision exprès.
    const existant = JSON.stringify({ mcpServers: { mangoqa: { command: 'node', args: ['./dist/mcp.js'] } } })
    const r = fusionnerMcpConfig(existant)
    expect(r.etat).toBe('refuse')
    expect(JSON.parse(r.contenu).mcpServers.mangoqa.command).toBe('node')
  })

  it('JSON illisible → REFUS, jamais un écrasement', () => {
    // Un fichier qu'on n'arrive pas à parser est peut-être un fichier précieux mal
    // formé. Le remplacer par le nôtre détruirait une configuration pour rendre service.
    const r = fusionnerMcpConfig('{ ceci n\'est pas du json')
    expect(r.etat).toBe('refuse')
    expect(r.contenu).toBe('{ ceci n\'est pas du json')
  })
})

// ── Le hook pre-push ────────────────────────────────────────────────────────

describe('hook pre-push', () => {
  const hook = contenuHookPrePush()

  it('audite le DIFF, pas le projet entier', () => {
    // Un pre-push doit rester de l'ordre de la dizaine de secondes : auditer tout le
    // dépôt à chaque poussée ferait désinstaller le hook dans la semaine, et un hook
    // désinstallé ne protège rien.
    expect(hook).toContain('--diff')
    expect(hook).not.toMatch(/mangoqa \.\s*$/m)
  })

  it('propage le code de sortie tel quel — donc 4 bloque aussi', () => {
    // Cohérent avec le lot 2 : on ne pousse pas plus sur « l'auditeur n'a pas pu
    // juger » que sur un feu rouge.
    expect(hook).toContain('exit $code')
    expect(hook).toContain("4 = l'auditeur n'a pas pu juger")
  })

  it('offre une échappatoire explicite', () => {
    // Sans elle, l'utilisateur pressé passe par `--no-verify`, qui désarme TOUS les
    // hooks du dépôt — y compris ceux des autres.
    expect(hook).toContain('MANGOQA_SKIP')
  })

  it('(P2) une panne d\'installation ne peut PAS être annoncée comme un feu rouge', () => {
    // L'ancienne version enchaînait deux `npx` et prenait le code de ce qui restait :
    // quand aucun ne pouvait s'installer, npm rendait 1 et le hook annonçait « poussée
    // refusée (code 1) » — FEU ROUGE — sur du code que personne n'avait lu.
    expect(hook).toContain('command -v mangoqa')
    expect(hook).toContain('auditeur introuvable')
    // Fail-open, invariant du produit : l'absence d'auditeur alerte mais ne bloque pas.
    expect(hook).toMatch(/auditeur introuvable[\s\S]*exit 0/)
  })

  it('(P2) ne suppose pas que `origin/HEAD` existe', () => {
    // Beaucoup de dépôts n'ont pas cette référence (clone partiel, dépôt local sans
    // remote) : s'en servir aveuglément faisait échouer l'audit lui-même.
    expect(hook).toContain('@{upstream}')
    expect(hook).toContain('pas de branche amont')
    // Aucune LIGNE EXÉCUTABLE ne doit encore s'y référer (les commentaires expliquent
    // justement pourquoi on ne s'en sert pas).
    const executables = hook.split('\n').filter(l => !l.trim().startsWith('#'))
    expect(executables.join('\n')).not.toContain('origin/HEAD')
  })

  it('(P2) le conseil de cohabitation ne recommande pas une forme cassée', () => {
    // Le refus expliquait comment cohabiter… en suggérant `--diff origin/HEAD`, la forme
    // qu'on venait justement d'abandonner parce qu'elle échoue sur beaucoup de dépôts.
    const conseil = planifierHook('#!/bin/sh\nnpm test\n').detail
    expect(conseil).not.toContain('origin/HEAD')
    expect(conseil).toContain('command -v mangoqa')
  })

  it('porte un marqueur qui le rend reconnaissable', () => {
    expect(estNotreHook(hook)).toBe(true)
    expect(estNotreHook('#!/bin/sh\nnpm test\n')).toBe(false)
  })

  it('absent → posé ; le nôtre périmé → mis à jour ; identique → inchangé', () => {
    expect(planifierHook(null).etat).toBe('ecrit')
    expect(planifierHook(`#!/bin/sh\n${MARQUEUR_HOOK}\nvieux\n`).etat).toBe('fusionne')
    expect(planifierHook(hook).etat).toBe('inchange')
  })

  it('le hook de QUELQU\'UN D\'AUTRE n\'est jamais remplacé, et on dit comment cohabiter', () => {
    const autre = '#!/bin/sh\nnpm run test:ci\n'
    const r = planifierHook(autre)
    expect(r.etat).toBe('refuse')
    expect(r.contenu).toBe(autre)
    expect(r.detail).toContain('|| exit $?')
  })
})

// ── L'action de CI ──────────────────────────────────────────────────────────

describe('workflow de CI', () => {
  const yml = contenuWorkflowCi()

  it('exige la couverture — en CI, personne ne lit le rapport', () => {
    // Un feu vert rendu sur 30 % du code y passerait pour une vérification : c'est le
    // mensonge que le lot 2 a supprimé de l'affichage, il ne revient pas par la CI.
    expect(yml).toContain('--exiger-couverture')
  })

  it('récupère tout l\'historique — sinon `--diff` n\'a rien à comparer', () => {
    expect(yml).toContain('fetch-depth: 0')
  })

  it('sans clé, il s\'ARRÊTE au lieu de rendre un audit vide', () => {
    expect(yml).toContain('ANTHROPIC_API_KEY')
    expect(yml).toContain('exit 2')
    expect(yml).toContain("aucun audit n'a été lancé")
  })

  it('documente les codes de sortie que la CI va interpréter', () => {
    expect(yml).toContain("4 l'auditeur n'a pas pu juger")
  })
})

// ── Les sous-commandes ──────────────────────────────────────────────────────

describe('parseArgs — sous-commandes', () => {
  const cmd = (argv: string[]): CommandeInstallation => {
    const r = parseArgs(argv)
    if (!('commande' in r)) throw new Error('sous-commande attendue')
    return r
  }

  it('`install-hook` est reconnu AVANT d\'être pris pour un nom de dossier', () => {
    // C'est le correctif exact que la branche Spec a proposé sur son propre diff.
    const c = cmd(['install-hook'])
    expect(c).toEqual({ commande: 'init', mcp: false, ci: false, hook: true })
  })

  it('`init` seul ne pose que le MCP ; les drapeaux ajoutent les autres portes', () => {
    expect(cmd(['init'])).toEqual({ commande: 'init', mcp: true, ci: false, hook: false })
    expect(cmd(['init', '--ci', '--hook'])).toEqual({ commande: 'init', mcp: true, ci: true, hook: true })
  })

  it('un DOSSIER cible peut être donné, dans n\'importe quel ordre', () => {
    // Ajouté après un vrai incident : sans cet argument, `init` n'écrivait que dans
    // `process.cwd()`, et une commande lancée depuis le mauvais dossier y a posé trois
    // fichiers. Une commande qui écrit sur disque doit permettre de choisir où.
    expect(cmd(['init', './autre'])).toMatchObject({ dossier: './autre', mcp: true })
    expect(cmd(['init', '--ci', './autre'])).toMatchObject({ dossier: './autre', ci: true })
    expect(cmd(['install-hook', './autre'])).toMatchObject({ dossier: './autre', hook: true, mcp: false })
  })

  it('deux dossiers → refus explicite', () => {
    expect(() => parseArgs(['init', './a', './b'])).toThrow(/Un seul dossier/)
  })

  it('une option inconnue est REFUSÉE en la nommant, pas ignorée', () => {
    expect(() => parseArgs(['init', '--tout'])).toThrow(/--tout/)
  })

  it('un dossier qui s\'appellerait « init » reste atteignable par ./init', () => {
    const r = parseArgs(['./init'])
    expect('commande' in r).toBe(false)
  })
})

// ── De bout en bout, sur un vrai dossier ────────────────────────────────────

describe('executerInstallation — sur disque', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mangoqa-init-'))
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('`init --ci --hook` pose les trois portes', () => {
    executerInstallation({ commande: 'init', mcp: true, ci: true, hook: true }, dir)
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true)
    expect(existsSync(path.join(dir, '.git', 'hooks', 'pre-push'))).toBe(true)
    expect(existsSync(path.join(dir, ...CHEMIN_WORKFLOW.split('/')))).toBe(true)
  })

  it('deux exécutions de suite ne cassent rien (idempotence réelle)', () => {
    executerInstallation({ commande: 'init', mcp: true, ci: true, hook: true }, dir)
    const avant = readFileSync(path.join(dir, '.mcp.json'), 'utf8')
    executerInstallation({ commande: 'init', mcp: true, ci: true, hook: true }, dir)
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe(avant)
  })

  it('un hook étranger survit à l\'installation', () => {
    const f = path.join(dir, '.git', 'hooks', 'pre-push')
    writeFileSync(f, '#!/bin/sh\nnpm run test:ci\n', 'utf8')
    executerInstallation({ commande: 'init', mcp: false, ci: false, hook: true }, dir)
    expect(readFileSync(f, 'utf8')).toBe('#!/bin/sh\nnpm run test:ci\n')
  })

  it('un workflow existant survit à l\'installation', () => {
    const f = path.join(dir, ...CHEMIN_WORKFLOW.split('/'))
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, 'name: le mien\n', 'utf8')
    executerInstallation({ commande: 'init', mcp: false, ci: true, hook: false }, dir)
    expect(readFileSync(f, 'utf8')).toBe('name: le mien\n')
  })

  it('hors dépôt git, le hook est refusé proprement — pas de .git fabriqué', () => {
    const sansGit = mkdtempSync(path.join(tmpdir(), 'mangoqa-nogit-'))
    try {
      executerInstallation({ commande: 'init', mcp: false, ci: false, hook: true }, sansGit)
      expect(existsSync(path.join(sansGit, '.git'))).toBe(false)
    } finally {
      rmSync(sansGit, { recursive: true, force: true })
    }
  })
})

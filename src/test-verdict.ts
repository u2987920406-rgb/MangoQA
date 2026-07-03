// Tests des angles morts (#Q4) : buildVerdict (LE contrat red/green avec MangoOS)
// et parseFirstJson (le décodeur des réponses LLM bruitées).
// Exécution : npx tsx src/test-verdict.ts — déterministe, zéro réseau, zéro disque.
import type { Branch, BranchFinding, ProjectFile } from './types.js'
import { buildVerdict, type BranchResult } from './verdict.js'
import { parseFirstJson } from './llm.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

// ── Fabriques ────────────────────────────────────────────────────────────────
function branch(id: string, blocking = true): Branch {
  return {
    id,
    label: id,
    emoji: '🧪',
    blocking,
    relevant: (files: ProjectFile[]) => files,
    audit: async () => ({ status: 'pass', summary: 'ok' }),
  }
}
function result(id: string, finding: BranchFinding, blocking = true): BranchResult {
  return { branch: branch(id, blocking), finding }
}

// ── Tout vert → green, rejection null ────────────────────────────────────────
{
  const v = buildVerdict(
    [result('archi', { status: 'pass', summary: 'ok' }), result('secu', { status: 'skip', summary: 'rien' })],
    0,
  )
  check('tout-vert → verdict green', v.verdict === 'green')
  check('tout-vert → rejection null', v.rejection === null)
  check('tout-vert → branches exposées', v.branches.archi.status === 'pass' && v.branches.secu.summary === 'rien')
}

// ── Un rouge (branche bloquante) → red + rejection complète ──────────────────
{
  const v = buildVerdict(
    [
      result('archi', { status: 'pass', summary: 'ok' }),
      result('secu', {
        status: 'fail',
        summary: 'faille XSS',
        rejectionId: 'xss-input',
        correctiveAction: 'échapper les entrées',
        ruleRef: 'OWASP A03',
      }),
      result('a11y', { status: 'fail', summary: 'label manquant' }),
    ],
    2,
  )
  check('un rouge → verdict red', v.verdict === 'red')
  check('un rouge → PREMIÈRE branche bloquante en échec retenue', v.rejection?.branch === 'secu')
  check('un rouge → rejection_id transmis', v.rejection?.rejection_id === 'xss-input')
  check('un rouge → corrective_action transmise', v.rejection?.corrective_action === 'échapper les entrées')
  check('un rouge → rule_ref transmise', v.rejection?.rule_ref === 'OWASP A03')
  check('un rouge → retry_count propagé', v.rejection?.retry_count === 2)
  check('un rouge → toutes les branches restent exposées', v.branches.a11y.status === 'fail')
}

// ── Fallbacks : fail sans détails → identifiants dérivés de la branche ───────
{
  const v = buildVerdict([result('perf', { status: 'fail', summary: 'trop lent' })], 1)
  check('fallback → rejection_id = <branche>-anomalie', v.rejection?.rejection_id === 'perf-anomalie')
  check('fallback → corrective_action = summary', v.rejection?.corrective_action === 'trop lent')
  check('fallback → rule_ref = id de branche', v.rejection?.rule_ref === 'perf')
}

// ── Branche de CONSEIL (non bloquante) en fail → jamais de Feu Rouge ─────────
{
  const v = buildVerdict([result('design-system', { status: 'fail', summary: 'hors palette' }, false)], 0)
  check('conseil en fail → verdict green', v.verdict === 'green')
  check('conseil en fail → rejection null', v.rejection === null)
}

// ── Vide → green (fail-open : pas de branche = pas de blocage) ───────────────
{
  const v = buildVerdict([], 0)
  check('vide → verdict green', v.verdict === 'green')
  check('vide → rejection null', v.rejection === null)
  check('vide → branches vides', Object.keys(v.branches).length === 0)
}

// ── parseFirstJson : JSON pur ────────────────────────────────────────────────
{
  const got = parseFirstJson<{ status: string }>('{"status":"pass"}')
  check('parse : JSON pur', got?.status === 'pass')
}

// ── parseFirstJson : JSON noyé dans du texte (préambule + fence + suite) ─────
{
  const raw = 'Voici mon verdict :\n```json\n{"status":"fail","summary":"boom"}\n```\nBonne journée !'
  const got = parseFirstJson<{ status: string; summary: string }>(raw)
  check('parse : JSON noyé dans du texte', got?.status === 'fail' && got?.summary === 'boom')
}

// ── parseFirstJson : objets imbriqués + accolades dans les strings ───────────
{
  const raw = 'bla {"a":{"b":1},"txt":"des {accolades} et un \\" échappé"} bla {"autre":2}'
  const got = parseFirstJson<{ a: { b: number }; txt: string }>(raw)
  check('parse : imbrication équilibrée (le PREMIER objet)', got?.a?.b === 1)
  check('parse : accolades dans les strings ignorées', got?.txt === 'des {accolades} et un " échappé')
}

// ── parseFirstJson : malformé / absent → null (fallback fail-open) ───────────
{
  check('parse : malformé → null', parseFirstJson('{"status": pas-du-json}') === null)
  check('parse : aucun objet → null', parseFirstJson('rien à parser ici') === null)
  check('parse : accolade jamais fermée → null', parseFirstJson('{"status":"pass"') === null)
  check('parse : chaîne vide → null', parseFirstJson('') === null)
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[verdict+llm] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)

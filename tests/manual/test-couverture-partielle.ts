// Test de NON-RÉGRESSION B2 (audit du 2026-09-28) — la couverture partielle.
//
// Défaut visé : un `skip` du modèle (« hors de ma spécialité ») est converti en
// `not_applicable`, statut INOFFENSIF qui n'empêche pas le Feu Vert. Le modèle
// peut donc répondre « rien à voir pour moi » alors que le prompt ne lui a montré
// qu'un PRÉFIXE du projet (cap de 24 000 caractères atteint). Résultat : Feu Vert
// sur une couverture quasi nulle — exactement ce que l'audit reproche.
//
// Exécution : npx tsx tests/manual/test-couverture-partielle.ts
// Déterministe, ZÉRO réseau (`ask` injecté).
import { auditWithLLM, type BranchMeta } from '../../src/llm.js'
import type { AuditContext, ProjectFile } from '../../src/types.js'
import { renderFilesDetailed } from '../../src/fs-shared.js'
import { buildVerdict } from '../../src/verdict.js'
import type { Branch, BranchFinding } from '../../src/types.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  ❌ ${name}`) }
}

const CAP = 24_000
const meta: BranchMeta = { id: 'security', specialty: 'sécurité' }

/** Contexte dont le payload dépasse largement le cap du prompt. */
function crowdedCtx(files: ProjectFile[]): AuditContext {
  return {
    signal: { projectName: 'p', phase: 'build', timestamp: 't', projectDir: '/p', changedFiles: [], retryCount: 0 },
    files,
    retex: '',
  }
}

// Fixtures calibrées sur le cap RÉEL de 24 000 : un seul fichier de 24 000
// sature déjà le payload, le suivant tombe donc entièrement.
// NB : point-virgule obligatoire — `=> ({…})` sans `;` suivi d'une ligne `{`
// est avalé par l'ASI et le bloc est parsé comme un corps de fonction.
const gros = (p: string): ProjectFile => ({ path: p, content: 'x'.repeat(24_000) });
const petit = (p: string): ProjectFile => ({ path: p, content: 'ok!' });

// ── 1. La mesure de couverture elle-même (source de vérité) ──────────────────
{
  const r = renderFilesDetailed([gros('a.ts'), petit('b.ts')], CAP)
  check('payload débordant : un seul fichier montré', r.shownCount === 1)
  check('payload débordant : un fichier perdu est COMPTÉ', r.droppedCount === 1)
  check('payload débordant : signalé comme tronqué', r.truncated === true)

  const r2 = renderFilesDetailed([petit('a.ts'), petit('b.ts')], CAP)
  check('payload qui tient : tout montré', r2.shownCount === 2 && r2.droppedCount === 0)
  check('payload qui tient : rien de tronqué', r2.truncated === false)

  // Le texte produit doit rester identique à l'ancien renderFiles (non-régression).
  check('le texte contient les deux en-têtes de fichiers montrés', r.text.includes('----- a.ts -----'))
  check('le texte porte le libellé de troncature', r.text.includes('(tronqué)'))
}

// ── 2. LE DÉFAUT : « hors sujet » alors qu'on n'a vu qu'un préfixe ───────────
{
  const f = await auditWithLLM(meta, crowdedCtx([gros('a.ts'), petit('b.ts')]), async () =>
    `{"status":"skip","summary":"Rien de pertinent pour ma spécialité."}`)
  check('couverture partielle : le skip invérifiable NE devient PAS not_applicable', f.status !== 'not_applicable')
  check('couverture partielle : il reste skip (donc verdict global unknown)', f.status === 'skip')
}

// ── 3. Le comportement historique est PRÉSERVÉ quand la couverture est totale ─
{
  const f = await auditWithLLM(meta, crowdedCtx([petit('a.ts'), petit('b.ts')]), async () =>
    `{"status":"skip","summary":"Rien de pertinent pour ma spécialité."}`)
  check('couverture totale : un skip légitime reste not_applicable', f.status === 'not_applicable')
}

// ── 4. LA CONSÉQUENCE : le Feu Vert ne peut plus sortir ──────────────────────
{
  function blocking(id: string, finding: BranchFinding): { branch: Branch; finding: BranchFinding } {
    const branch: Branch = { id, label: id, emoji: '🚨', blocking: true, relevant: () => [], audit: async () => finding }
    return { branch, finding }
  }
  const pass: BranchFinding = { status: 'pass', summary: 'ok' }

  // Ancienne situation : architecture=pass + security=not_applicable → vert sur
  // une couverture quasi nulle.
  const menteur = buildVerdict([blocking('architecture', pass), blocking('security', { status: 'not_applicable', summary: 'rien vu' })], 0)
  check('scénario ancien : not_applicable n\'empêche PAS le vert (le défaut)', menteur.verdict === 'green')

  // Nouvelle situation : le skip invérifiable fait retomber le verdict à unknown.
  const honnete = buildVerdict([blocking('architecture', pass), blocking('security', { status: 'skip', summary: 'couverture partielle' })], 0)
  check('scénario corrigé : le skip rend le verdict UNKNOWN, jamais vert', honnete.verdict === 'unknown')
}

console.log(`\n${failed === 0 ? '✅' : '❌'} couverture-partielle (B2) : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

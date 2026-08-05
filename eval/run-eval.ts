// J0 — HARNAIS D'ÉVALUATION de Mango QA.
//
// Rejoue le corpus étiqueté (`eval/corpus.ts`) contre les 6 branches RÉELLES et
// mesure, branche par branche :
//   • la DÉTECTION   — sur les cas où un défaut a été injecté, la branche dit-elle "fail" ?
//   • les FAUX POSITIFS — sur les cas propres, dit-elle "fail" alors qu'il n'y a rien ?
//   • les ABSTENTIONS — dit-elle "skip", et pourquoi (non pertinent vs réponse illisible) ?
//
// Pourquoi les abstentions comptent : la sonde MangoOS du 2026-07-24 avait observé
// « 1 succès net / 2 abstentions propres sur 3 tentatives » — une abstention n'est
// PAS un échec de jugement, mais la confondre avec une détection serait un mensonge.
// Elles ont donc leur propre colonne, jamais fondues dans un taux global.
//
// AUCUN MOCK : ce harnais appelle le VRAI cerveau d'audit configuré dans .env.
// C'est le seul moyen d'obtenir un chiffre qui veut dire quelque chose.
//
// Usage :
//   npx tsx eval/run-eval.ts                      # tout le corpus, 1 passe
//   npx tsx eval/run-eval.ts --only security      # une branche
//   npx tsx eval/run-eval.ts --case SEC-01        # un cas (préfixe accepté)
//   npx tsx eval/run-eval.ts --repeat 3           # 3 passes → mesure la VARIABILITÉ
//   npx tsx eval/run-eval.ts --json rapport.json  # sortie machine en plus du tableau

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import type { Branch, BranchFinding, PhaseSignal, ProjectFile } from '../src/types.js'
import { architecture } from '../src/branches/architecture.js'
import { security } from '../src/branches/security.js'
import { accessibility } from '../src/branches/accessibility.js'
import { performance } from '../src/branches/performance.js'
import { tests } from '../src/branches/tests.js'
import { designSystem } from '../src/branches/design-system.js'
import { askLLM } from '../src/llm.js'
import { CORPUS, corpusSummary, type BranchId, type EvalCase } from './corpus.js'

const BRANCHES: Branch[] = [architecture, security, accessibility, performance, tests, designSystem]
const BY_ID = new Map(BRANCHES.map((b) => [b.id as BranchId, b]))

// ── Arguments ────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const ONLY = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean) as BranchId[] | undefined
const CASE_FILTER = arg('case')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
const REPEAT = Math.max(1, Number(arg('repeat') ?? 1))
const JSON_OUT = arg('json')

// `--brain <modele>` — force le cerveau d'audit pour CETTE évaluation.
// Sur un modèle LOCAL (sans suffixe `:cloud`), deux ajustements sont indispensables,
// sinon la mesure est fausse :
//   • le timeout par défaut (25 s) est calibré pour un modèle cloud CHAUD ; un modèle
//     local de ~9 Go qui démarre à froid le dépasse systématiquement → on mesurerait
//     des timeouts, pas de la qualité de jugement ;
//   • le repli Claude doit être COUPÉ (QA_LOCAL_ONLY), sinon Claude répond à la place
//     du modèle testé et on croit mesurer le local alors qu'on mesure Claude.
const BRAIN = arg('brain')
if (BRAIN) {
  process.env.QA_OLLAMA_MODEL = BRAIN
  process.env.QA_OLLAMA_TIMEOUT_MS = arg('brain-timeout') ?? '300000'
  process.env.QA_LOCAL_ONLY = 'on'
}

// ── Résultat d'une observation (1 cas × 1 branche × 1 passe) ─────────────────

type Outcome =
  | 'detecte'        // défaut injecté ET la branche dit "fail"     → ✅
  | 'rate'           // défaut injecté ET la branche dit "pass"     → ❌ le trou
  | 'faux-positif'   // rien à trouver ET la branche dit "fail"     → ❌ le bruit
  | 'correct-pass'   // rien à trouver ET la branche dit "pass"     → ✅
  | 'abstention'     // la branche dit "skip" (elle n'a pas jugé)
  | 'non-pertinent'  // défaut injecté MAIS relevant() = [] : trou de FILTRAGE
  // (2026-08-05) Cas propre ET relevant() = [] : la branche n'avait rien à juger dans
  // son domaine. Auparavant compté en `correct-pass` — c'est-à-dire porté au crédit de
  // la branche comme un jugement propre réussi, alors qu'AUCUN jugement n'a eu lieu.
  // Mesuré sur LONG-01 : security affichait « 0 faux positif sur 6 » là où elle n'avait
  // réellement statué que 3 fois (LONG-01 n'a que du .jsx, hors de son périmètre).
  // Un dénominateur gonflé de non-événements flatte le taux de faux positifs — et
  // confondre « n'a pas regardé » avec « a regardé et n'a rien trouvé » est très
  // exactement le défaut que ce projet corrige côté produit depuis J2.
  | 'hors-perimetre'

interface Observation {
  caseId: string
  branch: BranchId
  pass: number
  expected: 'fail' | 'pass'
  got: BranchFinding['status'] | 'non-pertinent'
  outcome: Outcome
  summary: string
  /** Pour les branches de conseil : un mot-clé attendu a-t-il été mentionné ? */
  mentioned?: boolean
  durationMs: number
}

// ── Exécution d'une observation ──────────────────────────────────────────────

function signalFor(c: EvalCase): PhaseSignal {
  return {
    projectName: c.id,
    phase: 'eval',
    timestamp: new Date().toISOString(),
    projectDir: `<memoire>/${c.id}`,
    changedFiles: c.files.map((f) => f.path),
    retryCount: 0,
  }
}

function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

async function observe(c: EvalCase, branchId: BranchId, pass: number): Promise<Observation> {
  const branch = BY_ID.get(branchId)!
  const expected = c.expect[branchId]!
  const started = Date.now()

  const relevant: ProjectFile[] = branch.relevant(c.files)
  if (relevant.length === 0) {
    return {
      caseId: c.id, branch: branchId, pass, expected, got: 'non-pertinent',
      // Une branche qui ne REGARDE même pas un fichier porteur du défaut est un
      // trou de FILTRAGE, pas de jugement — distinct d'un raté, et souvent plus
      // grave (aucun modèle, si bon soit-il, ne peut le rattraper).
      // Sur un cas PROPRE, le même silence n'est ni un mérite ni une faute : c'est un
      // non-événement, qui ne doit entrer dans aucun dénominateur (cf. `hors-perimetre`).
      outcome: expected === 'fail' ? 'non-pertinent' : 'hors-perimetre',
      summary: 'Aucun fichier retenu par relevant().',
      durationMs: Date.now() - started,
    }
  }

  const finding = await branch.audit({
    signal: signalFor(c),
    files: relevant,
    retex: '',
    testsElsewhereInProject: c.testsElsewhereInProject,
  })
  const durationMs = Date.now() - started

  let outcome: Outcome
  if (finding.status === 'skip') outcome = 'abstention'
  else if (expected === 'fail') outcome = finding.status === 'fail' ? 'detecte' : 'rate'
  else outcome = finding.status === 'fail' ? 'faux-positif' : 'correct-pass'

  // Branches de conseil (design-system) : elles ne peuvent pas renvoyer "fail".
  // On note alors si le résumé MENTIONNE réellement le défaut injecté.
  let mentioned: boolean | undefined
  const keywords = c.expectMentions?.[branchId]
  if (keywords?.length) {
    const hay = normalise(finding.summary)
    mentioned = keywords.some((k) => hay.includes(normalise(k)))
  }

  return { caseId: c.id, branch: branchId, pass, expected, got: finding.status, outcome, summary: finding.summary, mentioned, durationMs }
}

// ── Préflight : le cerveau d'audit répond-il ? ───────────────────────────────

async function preflight(): Promise<boolean> {
  process.stdout.write('· Préflight du cerveau d\'audit… ')
  const started = Date.now()
  try {
    const raw = await askLLM(
      'Tu réponds UNIQUEMENT par un objet JSON, sans texte autour.',
      'Réponds exactement : {"ok":true}',
    )
    const ok = /"ok"\s*:\s*true/.test(raw)
    console.log(ok ? `OK (${Date.now() - started} ms)` : `réponse inattendue : ${raw.slice(0, 120)}`)
    return ok
  } catch (err) {
    console.log(`ÉCHEC — ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ── Agrégation ───────────────────────────────────────────────────────────────

interface BranchStats {
  branch: BranchId
  casDefaut: number
  detectes: number
  rates: number
  nonPertinents: number
  casPropres: number
  fauxPositifs: number
  /** Observations propres RÉELLEMENT jugées — dénominateur honnête des faux positifs.
   *  Exclut les `hors-perimetre`, où la branche n'a rien eu à regarder. */
  jugementsPropres: number
  /** Observations propres écartées faute de fichier dans le domaine de la branche. */
  horsPerimetre: number
  abstentions: number
  mentions: { attendues: number; obtenues: number }
  /** Nombre de cas dont le verdict A CHANGÉ entre deux passes (si --repeat > 1). */
  instables: number
  dureeMoyenneMs: number
}

function aggregate(obs: Observation[]): BranchStats[] {
  const out: BranchStats[] = []
  for (const branch of BY_ID.keys()) {
    const mine = obs.filter((o) => o.branch === branch)
    if (mine.length === 0) continue

    const parCas = new Map<string, Observation[]>()
    for (const o of mine) {
      if (!parCas.has(o.caseId)) parCas.set(o.caseId, [])
      parCas.get(o.caseId)!.push(o)
    }
    let instables = 0
    for (const list of parCas.values()) {
      if (new Set(list.map((o) => o.got)).size > 1) instables++
    }

    out.push({
      branch,
      casDefaut: [...parCas.values()].filter((l) => l[0].expected === 'fail').length,
      detectes: [...parCas.values()].filter((l) => l[0].expected === 'fail' && l.every((o) => o.outcome === 'detecte')).length,
      rates: mine.filter((o) => o.outcome === 'rate').length,
      nonPertinents: mine.filter((o) => o.outcome === 'non-pertinent').length,
      casPropres: [...parCas.values()].filter((l) => l[0].expected === 'pass').length,
      fauxPositifs: mine.filter((o) => o.outcome === 'faux-positif').length,
      jugementsPropres: mine.filter((o) => o.expected === 'pass' && o.outcome !== 'hors-perimetre').length,
      horsPerimetre: mine.filter((o) => o.outcome === 'hors-perimetre').length,
      abstentions: mine.filter((o) => o.outcome === 'abstention').length,
      mentions: {
        attendues: mine.filter((o) => o.mentioned !== undefined).length,
        obtenues: mine.filter((o) => o.mentioned === true).length,
      },
      instables,
      dureeMoyenneMs: Math.round(mine.reduce((s, o) => s + o.durationMs, 0) / mine.length),
    })
  }
  return out
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)} %`
}

// ── Rapport ──────────────────────────────────────────────────────────────────

function report(obs: Observation[], stats: BranchStats[], totalMs: number): string {
  const s = corpusSummary()
  const L: string[] = []
  L.push('# Mango QA — J0 · Mesure de la qualité de jugement')
  L.push('')
  // Heure LOCALE, pas UTC. `toISOString()` datait les rapports de 2 h dans le passé —
  // même piège que dans _ceiling.ts, corrigé là-bas le 2026-08-04 et pas ici. Un rapport
  // de mesure impossible à recouper avec les journaux système perd la moitié de sa valeur.
  L.push(`> Exécuté le ${new Date().toLocaleString('sv-SE').slice(0, 16)} (heure locale) · corpus : **${s.total} cas** (${s.defauts} à défaut · ${s.propres} propres)`)
  // (2026-08-05) L'en-tête décrit désormais les conditions RÉELLES du run, lues dans
  // l'environnement — plus la façon dont on les a réglées. Avant, il n'annonçait « repli
  // Claude COUPÉ » que si `--brain` avait été passé : régler `QA_LOCAL_ONLY=on` dans
  // l'environnement donnait un rapport affirmant qu'un repli Claude était actif alors
  // qu'il ne l'était pas. Un harnais de mesure qui se trompe sur ses propres conditions
  // est exactement le défaut que ce projet existe pour traquer.
  const strict = /^(on|1|true|yes)$/i.test((process.env.QA_LOCAL_ONLY ?? '').trim())
  const modele = process.env.QA_OLLAMA_MODEL ?? '(non défini)'
  const timeoutS = Number(process.env.QA_OLLAMA_TIMEOUT_MS ?? 25_000) / 1000
  L.push(
    `> Passes : **${REPEAT}** · cerveau : **\`${modele}\`** · timeout ${timeoutS} s · ` +
      (strict
        ? 'repli Claude **COUPÉ** (`QA_LOCAL_ONLY=on`) — un échec local reste un échec compté'
        : `repli Claude **ACTIF** vers \`${process.env.QA_MODEL ?? 'sonnet'}\` ⚠️ une réponse peut ne PAS venir du modèle mesuré`),
  )
  L.push(`> Durée totale : ${(totalMs / 1000).toFixed(1)} s · observations : ${obs.length}`)
  L.push('')
  L.push('## Résultat par branche')
  L.push('')
  L.push('| Branche | Détection | Ratés | Non pertinents | Faux positifs | Abstentions | Instables | Durée moy. |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const st of stats) {
    // Dénominateur des faux positifs = observations propres RÉELLEMENT jugées. Les
    // `hors-perimetre` sont affichés à côté, jamais fondus dedans.
    const fp = `**${st.fauxPositifs}/${st.jugementsPropres}**${st.horsPerimetre ? ` (+${st.horsPerimetre} hors périmètre)` : ''}`
    L.push(
      `| ${st.branch} | **${st.detectes}/${st.casDefaut}** (${pct(st.detectes, st.casDefaut)}) | ${st.rates} | ${st.nonPertinents} | ${fp} | ${st.abstentions} | ${REPEAT > 1 ? st.instables : '—'} | ${(st.dureeMoyenneMs / 1000).toFixed(1)} s |`,
    )
  }
  L.push('')

  const conseil = stats.filter((st) => st.mentions.attendues > 0)
  if (conseil.length) {
    L.push('## Branches de conseil (ne peuvent jamais bloquer)')
    L.push('')
    L.push('| Branche | Défaut mentionné dans le résumé |')
    L.push('|---|---|')
    for (const st of conseil) {
      L.push(`| ${st.branch} | **${st.mentions.obtenues}/${st.mentions.attendues}** (${pct(st.mentions.obtenues, st.mentions.attendues)}) |`)
    }
    L.push('')
  }

  const problemes = obs.filter((o) => o.outcome === 'rate' || o.outcome === 'faux-positif' || o.outcome === 'non-pertinent')
  L.push(`## Détail des ${problemes.length} observation(s) à revoir`)
  L.push('')
  if (problemes.length === 0) {
    L.push('_Aucune. À vérifier manuellement avant de conclure — un score parfait sur 20 cas se relit._')
  } else {
    for (const o of problemes) {
      const c = CORPUS.find((x) => x.id === o.caseId)!
      const etiquette =
        o.outcome === 'rate' ? '❌ RATÉ' : o.outcome === 'faux-positif' ? '⚠️ FAUX POSITIF' : '🚫 NON PERTINENT (filtre)'
      L.push(`### ${etiquette} · \`${o.caseId}\` → branche \`${o.branch}\`${REPEAT > 1 ? ` (passe ${o.pass})` : ''}`)
      L.push('')
      L.push(`- **Défaut injecté** : ${c.defect}`)
      if (c.location) L.push(`- **Emplacement** : \`${c.location}\``)
      if (c.rule) L.push(`- **Règle attendue** : ${c.rule}`)
      L.push(`- **Attendu** : \`${o.expected}\` · **Obtenu** : \`${o.got}\``)
      L.push(`- **Ce qu'a répondu la branche** : ${o.summary.slice(0, 400)}`)
      L.push('')
    }
  }

  L.push('## Comment lire ces chiffres')
  L.push('')
  L.push('- **Détection** : un cas ne compte que si TOUTES les passes l\'ont détecté (exigeant volontairement).')
  L.push('- **⚠️ Deux unités dans ce tableau.** « Détection » se compte en **cas** (dénominateur = nombre de cas')
  L.push('  à défaut), « Faux positifs » et « Abstentions » en **observations** (cas × passes). `1/1` en détection')
  L.push('  sur 3 passes veut donc dire « l\'unique cas à défaut, détecté aux 3 passes », pas « une passe sur une ».')
  L.push('- **Non pertinent** : sur un cas à DÉFAUT, `relevant()` n\'a retenu aucun fichier — la branche')
  L.push('  n\'a même pas regardé. C\'est un trou de **filtrage**, pas de jugement : aucun modèle, si bon')
  L.push('  soit-il, ne peut le rattraper.')
  L.push('- **Hors périmètre** : sur un cas PROPRE, `relevant()` n\'a rien retenu non plus. Ce n\'est ni un')
  L.push('  mérite ni une faute, c\'est un non-événement — donc **exclu du dénominateur des faux positifs**.')
  L.push('  Le compter en « pass correct » gonflait le dénominateur de jugements qui n\'ont jamais eu lieu,')
  L.push('  et flattait le taux (corrigé le 2026-08-05 : security affichait 0/6 pour 3 jugements réels).')
  L.push('- **Abstention** : la branche a répondu `skip` (réponse illisible, erreur interne). Ni détection, ni faute.')
  L.push('- **Instables** : verdicts différents d\'une passe à l\'autre sur le même cas. Un auditeur instable est')
  L.push('  inutilisable en CI, même avec un bon taux de détection.')
  L.push('- **Un score de détection élevé n\'a de sens qu\'accompagné d\'un taux de faux positifs bas.** Une branche')
  L.push('  qui répondrait `fail` à tout obtiendrait 100 % de détection et serait sans valeur.')
  return L.join('\n')
}

// ── Boucle principale ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cases = CORPUS.filter(
    (c) => !CASE_FILTER || CASE_FILTER.some((f) => c.id.toLowerCase().startsWith(f)),
  )
  if (cases.length === 0) {
    console.error(`Aucun cas ne correspond à --case ${CASE_FILTER?.join(',')}`)
    process.exit(1)
  }

  const plan: Array<{ c: EvalCase; b: BranchId }> = []
  for (const c of cases) {
    for (const b of Object.keys(c.expect) as BranchId[]) {
      if (ONLY && !ONLY.includes(b)) continue
      if (!BY_ID.has(b)) continue
      plan.push({ c, b })
    }
  }

  const s = corpusSummary()
  console.log(`\n🥭 Mango QA — J0 · évaluation`)
  console.log(`   corpus : ${s.total} cas (${s.defauts} à défaut, ${s.propres} propres)`)
  console.log(`   plan   : ${plan.length} observation(s) × ${REPEAT} passe(s) = ${plan.length * REPEAT} appel(s) d'audit\n`)

  if (!(await preflight())) {
    console.error('\n⛔ Le cerveau d\'audit ne répond pas — mesure impossible.')
    console.error('   Vérifie .env (QA_OLLAMA_MODEL / QA_MODEL) et que le daemon Ollama tourne.')
    console.error('   Aucun rapport ne sera écrit : un chiffre obtenu sans cerveau ne vaut rien.')
    process.exit(2)
  }
  console.log('')

  const obs: Observation[] = []
  const t0 = Date.now()
  // SÉQUENTIEL, volontairement : Ollama est mono-GPU et l'abonnement Claude est
  // limité en débit. Paralléliser fausserait les durées ET déclencherait des 429.
  for (let pass = 1; pass <= REPEAT; pass++) {
    for (let i = 0; i < plan.length; i++) {
      const { c, b } = plan[i]
      const tag = `[${String(i + 1).padStart(3)}/${plan.length}]${REPEAT > 1 ? ` p${pass}` : ''}`
      process.stdout.write(`${tag} ${c.id} → ${b} … `)
      const o = await observe(c, b, pass)
      obs.push(o)
      const mark =
        o.outcome === 'detecte' || o.outcome === 'correct-pass' ? '✓'
        : o.outcome === 'rate' ? '✗ RATÉ'
        : o.outcome === 'faux-positif' ? '⚠ FAUX POSITIF'
        : o.outcome === 'non-pertinent' ? '🚫 non pertinent'
        // Non-événement : à ne PAS afficher comme une abstention, qui elle est un
        // vrai échec de jugement (réponse illisible, erreur interne).
        : o.outcome === 'hors-perimetre' ? '– hors périmètre'
        : '· abstention'
      console.log(`${mark} (${(o.durationMs / 1000).toFixed(1)} s)`)
    }
  }
  const totalMs = Date.now() - t0

  const stats = aggregate(obs)
  const md = report(obs, stats, totalMs)

  const outDir = path.join(process.cwd(), 'eval', 'rapports')
  fs.mkdirSync(outDir, { recursive: true })
  // Heure LOCALE ici aussi : un rapport daté 00-34 dans son NOM et 02:34 dans son en-tête
  // est un rapport qu'on classera mal et qu'on recoupera mal (même piège que l'en-tête).
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 19).replace(/[: ]/g, '-')
  const mdPath = path.join(outDir, `J0-${stamp}.md`)
  fs.writeFileSync(mdPath, md, 'utf8')

  console.log('\n' + md.split('## Détail')[0])
  console.log(`\n📄 Rapport complet : ${mdPath}`)

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ stats, observations: obs, totalMs }, null, 2), 'utf8')
    console.log(`📄 JSON : ${JSON_OUT}`)
  }
}

main().catch((err) => {
  console.error('\n⛔ Échec du harnais :', err)
  process.exit(1)
})

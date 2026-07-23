// Corpus de défauts RÉELS connus (#196 fault-finding Partie 4, côté MangoOS —
// plan run-login-cached-noodle.md). Chaque item reproduit un incident DOCUMENTÉ
// dans la mémoire MangoOS (retours goût 2026-07-10 + trouvailles du 2026-07-23),
// pas un bug fuzzé au hasard. `expectedCatchers` = les branches dont la
// SPÉCIALITÉ DÉCLARÉE (src/branches/*.ts) rend un « fail » plausible — sert à
// distinguer un vrai gap structurel (aucune branche n'a même vocation à
// regarder ça) d'un raté ponctuel (une branche compétente a manqué le coup).
import type { ProjectFile } from '../../src/types.js'

export interface CorpusItem {
  id: string
  /** Référence à l'incident réel documenté (memory MangoOS). */
  incident: string
  files: ProjectFile[]
  /** Branches dont la spécialité couvre plausiblement ce défaut. [] = aucune
   *  branche actuelle n'a vocation à l'attraper (gap structurel attendu). */
  expectedCatchers: string[]
}

export const FAULT_CORPUS: CorpusItem[] = [
  {
    id: 'quiz-toujours-a',
    incident: 'Retour goût 2026-07-10 : "réponse quiz toujours a" (correctIndex non randomisé/faux)',
    files: [
      {
        path: 'src/data/quiz-questions.ts',
        content: `// Banque de questions du quiz — générée automatiquement.
export interface QuizQuestion {
  question: string
  options: string[]
  correctIndex: number
}

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  { question: "Quelle est la capitale de la France ?", options: ["Paris", "Lyon", "Marseille", "Nice"], correctIndex: 0 },
  { question: "Combien font 2 + 2 ?", options: ["3", "5", "4", "6"], correctIndex: 0 },
  { question: "Quel est le plus grand océan ?", options: ["Atlantique", "Indien", "Arctique", "Pacifique"], correctIndex: 0 },
  { question: "Qui a peint la Joconde ?", options: ["Van Gogh", "Picasso", "Monet", "Léonard de Vinci"], correctIndex: 0 },
  { question: "Quelle planète est la plus proche du Soleil ?", options: ["Vénus", "Terre", "Mercure", "Mars"], correctIndex: 0 },
]
`,
      },
    ],
    // Aucune branche actuelle n'audite la CORRECTION SÉMANTIQUE d'une donnée
    // (ex: "4" est en position 2, pas 0, donc correctIndex:0 est objectivement
    // faux pour la question 2) — c'est un défaut de CONTENU, pas de code.
    expectedCatchers: [],
  },
  {
    id: 'photo-hors-contexte',
    incident: 'Retour goût 2026-07-10 : "photo ≠ contexte" (adéquation sémantique image/texte)',
    files: [
      {
        path: 'src/components/DestinationCard.tsx',
        content: `export function DestinationCard() {
  return (
    <figure>
      <img src="/images/coucher-de-soleil-plage.jpg" alt="Un chat noir endormi sur un canapé" />
      <figcaption>Découvrez le coucher de soleil magique sur les plages de Bali</figcaption>
    </figure>
  )
}
`,
      },
    ],
    // La branche Accessibilité vérifie explicitement que les <img> ont "un alt
    // PERTINENT" (WCAG 1.1.1) — un texte alternatif qui décrit un chat endormi
    // sous une légende sur un coucher de soleil à Bali est un candidat plausible.
    expectedCatchers: ['accessibility'],
  },
  {
    id: 'constante-physique-fausse',
    incident: 'Retour goût 2026-07-10 : "constantes physiques fausses (Saturne trop vite)"',
    files: [
      {
        path: 'src/lib/solar-system-sim.ts',
        content: `// Simulation du système solaire — période orbitale en JOURS terrestres.
export const ORBITAL_PERIOD_DAYS: Record<string, number> = {
  Mercure: 88,
  Venus: 225,
  Terre: 365,
  Mars: 687,
  Jupiter: 4333,
  Saturne: 29,
  Uranus: 30687,
  Neptune: 60190,
}

export function angularSpeedRadPerDay(planet: string): number {
  const period = ORBITAL_PERIOD_DAYS[planet]
  return (2 * Math.PI) / period
}
`,
      },
    ],
    // Défaut de CONNAISSANCE DOMAINE (Saturne orbite en ~29 ANS = 10 759 jours,
    // pas 29 jours — ~370x trop vite) — aucune branche n'a vocation à vérifier
    // l'exactitude FACTUELLE d'une constante scientifique.
    expectedCatchers: [],
  },
  {
    id: 'verrou-avant-travail',
    incident: 'Trouvaille RÉELLE #196 Partie 2 (2026-07-23) : lastAutoRun posé AVANT le lot, pas après (taste-nocturnal.ts, version pré-correctif)',
    files: [
      {
        path: 'src/taste/taste-nocturnal.ts',
        content: `export async function tasteSchedulerTick(now: number = Date.now()): Promise<boolean> {
  const cfg = loadTasteNocturnalConfig()
  if (!cfg.enabled || running) return false
  if (new Date(now).getHours() !== cfg.hour) return false
  if (cfg.lastAutoRun === localDate(now)) return false
  // Verrou anti-doublon posé AVANT le lancement du lot — un crash pendant le
  // lot ne relève jamais cette exception : la nuit est perdue ET plus aucune
  // reprise n'est possible avant demain, alors qu'aucun run n'a réussi.
  saveTasteNocturnalConfig({ ...cfg, lastAutoRun: localDate(now) })
  await runNocturnalTasteBatch(cfg)
  return true
}
`,
      },
    ],
    // Contrôle POSITIF (contraste) : un défaut structurel de résilience/ordre
    // d'opérations — au cœur de la spécialité Architecture ("couplage fort
    // évitable", défaut structurel concret) et potentiellement Tests (logique
    // non triviale non couverte). On attend un DÉTECTION plus plausible ici.
    expectedCatchers: ['architecture', 'tests'],
  },
]

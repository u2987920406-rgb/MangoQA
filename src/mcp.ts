#!/usr/bin/env node
// J3 — Serveur MCP de Mango QA : exposer l'auditeur à un client LLM.
//
//     mangoqa-mcp          (transport stdio)
//
// Pourquoi MCP en plus de la CLI : la CLI sert un humain qui lit un verdict ;
// MCP sert un ASSISTANT qui va agir dessus. C'est le cas d'usage le plus exposé
// au défaut de J1 — un modèle qui lit « FEU VERT » sans savoir que l'audit n'a
// porté que sur 27 % du code va rapporter à l'utilisateur que son projet est sain.
//
// D'où la règle de conception de ce fichier, héritée de J2 : la COUVERTURE est
// dans le schéma de sortie (champ REQUIS, donc structurellement impossible à
// ignorer) ET en tête du texte lisible. Pas en annexe.
//
// ⚠️ STDOUT EST LE CANAL JSON-RPC. Un seul `console.log` corrompt le protocole et
// le client voit une erreur de parsing incompréhensible. Tout diagnostic passe par
// `console.error` (stderr). Vérifié : la chaîne d'audit (audit → project-files →
// branches → llm → ollama-client) n'écrit que des `console.warn`, et `dotenv` est
// silencieux sur stdout. Un test gèle cet invariant.
import 'dotenv/config'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { auditProject, ALL_BRANCHES, type AuditReport } from './audit.js'

const VERSION = '2.1.0'

/** Charge le SDK MCP à la demande — dépendance de pair OPTIONNELLE, comme le SDK
 *  Claude et tree-sitter. Le SDK MCP et ses dépendances (express, hono, zod, ajv…)
 *  pèsent ~16 Mo : quelqu'un qui installe la CLI pour auditer un dossier depuis son
 *  terminal n'a aucune raison de les payer. Message actionnable si absent, jamais un
 *  `ERR_MODULE_NOT_FOUND` brut. */
async function chargerSdkMcp() {
  try {
    const [{ McpServer }, { StdioServerTransport }, zod] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('zod'),
    ])
    return { McpServer, StdioServerTransport, z: zod.z }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        "Serveur MCP indisponible : @modelcontextprotocol/sdk n'est pas installé " +
          '(dépendance optionnelle, ~16 Mo avec ses dépendances). Pour l\'activer : ' +
          'npm i @modelcontextprotocol/sdk zod',
      )
    }
    throw err
  }
}

const IDS_BRANCHES = ALL_BRANCHES.map(b => b.id)

/** Rend le rapport en texte pour le modèle. La couverture vient AVANT le verdict :
 *  un verdict lu sans son périmètre est très exactement le défaut que J2 a corrigé,
 *  et un client LLM le relaiera tel quel à l'utilisateur. */
export function rendreTexteMcp(r: AuditReport): string {
  if (r.empty) return `Aucun fichier auditable dans ${r.projectDir}.`

  const l: string[] = []
  const cov = r.coverage
  if (cov.complete) {
    l.push(`COUVERTURE : complète — les ${cov.filesRead} fichiers du projet ont été lus et vus en entier.`)
  } else {
    l.push('⚠️ COUVERTURE INCOMPLÈTE — le verdict ci-dessous ne porte PAS sur tout le code.')
    l.push(`   Fichiers découverts : ${cov.filesDiscovered} · lus : ${cov.filesRead}`)
    if (cov.filesDropped.length) l.push(`   Jamais lus : ${cov.filesDropped.join(', ')}`)
    if (cov.filesTruncated.length) l.push(`   Coupés à la lecture : ${cov.filesTruncated.join(', ')}`)
    for (const b of r.branches) {
      const c = b.coverage
      if (!c || c.complete) continue
      l.push(
        `   ${b.id} : ${c.filesRendered}/${c.filesTotal} fichiers envoyés au modèle` +
          (c.omitted.length ? ` — non vus : ${c.omitted.join(', ')}` : ''),
      )
    }
    l.push("   Ne conclus pas à l'absence d'un défaut à partir de cet audit.")
  }

  l.push('')
  l.push(`VERDICT : ${r.verdict.verdict === 'green' ? 'FEU VERT' : 'FEU ROUGE'}${cov.complete ? '' : ' (SUR LECTURE PARTIELLE)'}`)
  if (r.verdict.rejection) {
    l.push(`Branche en échec : ${r.verdict.rejection.branch} (${r.verdict.rejection.rejection_id})`)
    l.push(`Correctif : ${r.verdict.rejection.corrective_action}`)
    if (r.verdict.rejection.rule_ref) l.push(`Règle : ${r.verdict.rejection.rule_ref}`)
  }

  l.push('')
  l.push('Détail par branche :')
  for (const b of r.branches) {
    const c = b.coverage
    const vu = c ? `${c.filesRendered}/${c.filesTotal} vus${c.complete ? '' : ' ⚠️'}` : `${b.filesAudited} fichiers`
    l.push(`  [${b.finding.status}] ${b.label} (${vu}) — ${b.finding.summary}`)
  }
  return l.join('\n')
}

/** La partie structurée. `coverage` est REQUIS : un client qui désérialise le
 *  résultat ne peut pas obtenir un verdict sans son périmètre. */
export function rendreStructureMcp(r: AuditReport): Record<string, unknown> {
  return {
    verdict: r.verdict.verdict,
    couvertureComplete: r.coverage.complete,
    couverture: {
      complete: r.coverage.complete,
      fichiersDecouverts: r.coverage.filesDiscovered,
      fichiersLus: r.coverage.filesRead,
      fichiersJamaisLus: r.coverage.filesDropped,
      fichiersCoupes: r.coverage.filesTruncated,
      branchesPartielles: r.branches
        .filter(b => b.coverage && !b.coverage.complete)
        .map(b => ({
          branche: b.id,
          fichiersVus: b.coverage!.filesRendered,
          fichiersPertinents: b.coverage!.filesTotal,
          fichiersNonVus: b.coverage!.omitted,
        })),
    },
    rejet: r.verdict.rejection
      ? {
          branche: r.verdict.rejection.branch,
          identifiant: r.verdict.rejection.rejection_id,
          correctif: r.verdict.rejection.corrective_action,
          regle: r.verdict.rejection.rule_ref,
        }
      : null,
    branches: r.branches.map(b => ({
      id: b.id,
      libelle: b.label,
      statut: b.finding.status,
      bloquante: b.blocking,
      resume: b.finding.summary,
      fichiersPertinents: b.filesAudited,
      fichiersVus: b.coverage?.filesRendered ?? null,
      dureeMs: b.durationMs,
    })),
    projet: r.projectName,
    dossier: r.projectDir,
    dureeMs: r.durationMs,
  }
}

export async function creerServeur() {
  const { McpServer, z } = await chargerSdkMcp()

  const serveur = new McpServer({ name: 'mango-qa', version: VERSION })

  serveur.registerTool(
    'auditer_projet',
    {
      title: 'Auditer un projet',
      description:
        "Audite un dossier de code avec les 6 branches de Mango QA (architecture, sécurité, " +
        'accessibilité, performance, tests, design system) et rend un verdict Feu Vert / Feu Rouge.\n\n' +
        "IMPORTANT : le résultat contient une COUVERTURE. Lis-la avant le verdict. Si " +
        '`couvertureComplete` est faux, l\'audit n\'a pas porté sur tout le code : rapporte-le à ' +
        "l'utilisateur et ne conclus PAS qu'un défaut est absent.\n\n" +
        "Coût : un audit complet sur un cerveau local prend plusieurs minutes par branche. Utilise " +
        '`only` pour cibler les branches qui intéressent la question posée.',
      inputSchema: {
        dossier: z.string().describe('Chemin du dossier de code à auditer (absolu de préférence).'),
        only: z
          .array(z.enum(IDS_BRANCHES as [string, ...string[]]))
          .optional()
          .describe(`Sous-ensemble de branches à exécuter. Défaut : les 6. Valeurs : ${IDS_BRANCHES.join(', ')}.`),
        cap: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Caractères de code max injectés par prompt (défaut 100000). Baisser réduit la couverture.'),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Branches exécutées en parallèle. Défaut 1 (cerveau local mono-GPU).'),
      },
      outputSchema: {
        verdict: z.enum(['green', 'red']),
        // Requis, pas optionnel : c'est tout l'objet de J2.
        couvertureComplete: z.boolean().describe("Faux = le verdict ne porte pas sur tout le code."),
        couverture: z.object({
          complete: z.boolean(),
          fichiersDecouverts: z.number(),
          fichiersLus: z.number(),
          fichiersJamaisLus: z.array(z.string()),
          fichiersCoupes: z.array(z.string()),
          branchesPartielles: z.array(
            z.object({
              branche: z.string(),
              fichiersVus: z.number(),
              fichiersPertinents: z.number(),
              fichiersNonVus: z.array(z.string()),
            }),
          ),
        }),
        rejet: z
          .object({
            branche: z.string(),
            identifiant: z.string(),
            correctif: z.string(),
            regle: z.string(),
          })
          .nullable(),
        branches: z.array(
          z.object({
            id: z.string(),
            libelle: z.string(),
            statut: z.string(),
            bloquante: z.boolean(),
            resume: z.string(),
            fichiersPertinents: z.number(),
            fichiersVus: z.number().nullable(),
            dureeMs: z.number(),
          }),
        ),
        projet: z.string(),
        dossier: z.string(),
        dureeMs: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dossier, only, cap, concurrency }) => {
      if (cap !== undefined) process.env.QA_FILE_PAYLOAD_CAP = String(cap)
      try {
        const rapport = await auditProject(dossier, {
          concurrency: concurrency ?? 1,
          ...(only?.length ? { only } : {}),
        })
        return {
          content: [{ type: 'text' as const, text: rendreTexteMcp(rapport) }],
          structuredContent: rendreStructureMcp(rapport),
        }
      } catch (err) {
        // `auditProject` ne lève que si le dossier est inutilisable (fail-open
        // partout ailleurs). C'est une erreur d'USAGE, pas un défaut d'audit —
        // le modèle doit pouvoir corriger le chemin et réessayer.
        return {
          content: [
            { type: 'text' as const, text: `Audit impossible : ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        }
      }
    },
  )

  serveur.registerTool(
    'lister_branches',
    {
      title: 'Lister les branches d\'audit',
      description:
        "Liste les branches d'audit disponibles et leurs identifiants, à passer à `only` " +
        "d'`auditer_projet`. Sans coût : aucune lecture de code, aucun appel de modèle.",
      inputSchema: {},
      outputSchema: {
        branches: z.array(
          z.object({
            id: z.string(),
            libelle: z.string(),
            bloquante: z.boolean().describe('Une branche non bloquante ne peut jamais déclencher un Feu Rouge.'),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const branches = ALL_BRANCHES.map(b => ({ id: b.id, libelle: b.label, bloquante: b.blocking }))
      return {
        content: [
          {
            type: 'text' as const,
            text: branches.map(b => `${b.id} — ${b.libelle}${b.bloquante ? '' : ' (conseil, jamais bloquante)'}`).join('\n'),
          },
        ],
        structuredContent: { branches },
      }
    },
  )

  return serveur
}

export async function main(): Promise<number> {
  let serveur: Awaited<ReturnType<typeof creerServeur>>
  let StdioServerTransport: Awaited<ReturnType<typeof chargerSdkMcp>>['StdioServerTransport']
  try {
    ;({ StdioServerTransport } = await chargerSdkMcp())
    serveur = await creerServeur()
  } catch (err) {
    console.error(`[mangoqa-mcp] ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  await serveur.connect(new StdioServerTransport())
  // `connect` rend la main dès que le transport écoute ; le process reste vivant
  // tant que stdin est ouvert. Diagnostic sur STDERR — jamais stdout.
  console.error(`[mangoqa-mcp] 🥭 Mango QA ${VERSION} — serveur MCP prêt (stdio).`)
  return 0
}

/** Même détection de point d'entrée que la CLI — par URL de module et chemin réel,
 *  jamais par le nom du fichier : `npm i -g` installe un lien nommé `mangoqa-mcp`. */
function estPointDEntree(): boolean {
  const entree = process.argv[1]
  if (!entree) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entree)).href
  } catch {
    return false
  }
}

if (estPointDEntree()) {
  main()
    .then(code => {
      if (code !== 0) process.exit(code)
    })
    .catch(err => {
      console.error(`[mangoqa-mcp] erreur inattendue : ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    })
}

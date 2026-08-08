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
import { LIBELLE_CAUSE, estNonVerifie } from './verdict.js'
import { CerveauInutilisableError } from './preflight.js'

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

  // SPEC — contre quelle DEMANDE. C'est la déclaration la plus importante pour un
  // assistant : il rapporte volontiers « ton projet est bon » là où la seule question de
  // son utilisateur est « est-ce que ça fait ce que j'ai demandé ? ».
  const sp = r.spec
  l.push('')
  if (sp.file === null) {
    l.push(
      "SPEC : aucune fournie. Cet audit ne dit RIEN sur la conformité à la demande — il juge la " +
        "qualité du code, pas le fait qu'il réponde au besoin. Ne conclus pas que le travail est complet.",
    )
  } else {
    l.push(`SPEC : ${sp.exigencesProvided} exigence(s) lue(s) dans ${sp.file}.`)
    for (const e of sp.citedTexts) l.push(`   NON SATISFAITE ${e.id} — « ${e.text} »`)
    if (sp.rejected.length) {
      l.push(`   ⚠️ Citation(s) rejetée(s), sans exigence réelle : ${sp.rejected.join(', ')}`)
    }
  }

  // CONVENTIONS — contre quoi le jugement a été rendu. Le cas « aucune » compte autant
  // que l'autre : sans lui, un assistant conclut volontiers « conforme aux conventions
  // du projet » alors que le projet n'en a jamais écrit une seule.
  const conv = r.conventions
  if (conv) {
    l.push('')
    if (conv.absent) {
      l.push(
        "CONVENTIONS : ce dépôt n'en documente aucune. Le verdict porte sur les seules spécialités " +
          "de Mango QA — ne le présente pas comme une conformité aux règles du projet.",
      )
    } else {
      l.push(`CONVENTIONS : ${conv.rulesProvided} règle(s) lue(s) dans ${conv.files.join(', ')}.`)
      if (conv.cited.length) l.push(`   Invoquée(s) par une trouvaille : ${conv.cited.join(', ')}`)
      if (conv.rejected.length) {
        l.push(`   ⚠️ Citation(s) rejetée(s), sans correspondance réelle : ${conv.rejected.join(', ')}`)
      }
      l.push(
        '   Ces règles ont été FOURNIES au jugement — une règle non citée peut avoir été vérifiée ' +
          'et respectée. Ne présente pas cette liste comme « les seules règles vérifiées ».',
      )
    }
  }

  // JUGEMENT — même rang que la couverture. C'est ici que le risque est le plus grand :
  // un assistant qui lit « FEU VERT » alors qu'aucune branche n'a jugé rapportera à son
  // utilisateur que le projet est sain. Le texte doit rendre cette lecture impossible.
  const jug = r.jugement
  const nonVerifie = estNonVerifie(r.verdict.verdict, jug.complet)
  if (jug.nonJugees.length > 0) {
    l.push('')
    l.push("⚠️ JUGEMENT INCOMPLET — des branches n'ont pas PU juger (panne de l'auditeur, pas absence de défaut) :")
    for (const b of jug.nonJugees) {
      l.push(`   ${b.id}${b.blocking ? '' : ' (conseil)'} : ${LIBELLE_CAUSE[b.cause]}`)
    }
  }

  l.push('')
  // Un feu ROUGE reste rouge : un défaut trouvé est un fait que le silence d'une
  // branche voisine n'annule pas. Seul le VERT se dégrade — c'est lui qui affirme
  // une absence.
  l.push(
    nonVerifie
      ? "VERDICT : NON VÉRIFIÉ — ni vert, ni rouge. L'auditeur n'a pas pu juger : ne rapporte PAS ce projet comme sain, " +
          "et n'agis pas comme si aucun défaut n'existait."
      : `VERDICT : ${r.verdict.verdict === 'green' ? 'FEU VERT' : 'FEU ROUGE'}${cov.complete ? '' : ' (SUR LECTURE PARTIELLE)'}${jug.complet ? '' : ' (JUGEMENT INCOMPLET)'}`,
  )
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
    // Requis au même titre que `couvertureComplete` : un client qui désérialise ne
    // peut pas obtenir un verdict sans savoir s'il a été rendu.
    jugementComplet: r.jugement.complet,
    jugement: {
      complet: r.jugement.complet,
      branchesNonJugees: r.jugement.nonJugees.map(b => ({
        branche: b.id,
        cause: b.cause,
        raison: LIBELLE_CAUSE[b.cause],
        bloquante: b.blocking,
      })),
    },
    spec: {
      fournie: r.spec.file !== null,
      fichier: r.spec.file,
      exigencesFournies: r.spec.exigencesProvided,
      exigencesNonSatisfaites: r.spec.citedTexts,
      citationsRejetees: r.spec.rejected,
    },
    conventions: r.conventions
      ? {
          documentees: !r.conventions.absent,
          fichiers: r.conventions.files,
          reglesFournies: r.conventions.rulesProvided,
          reglesEcartees: r.conventions.rulesDropped,
          reglesInvoquees: r.conventions.cited,
          citationsRejetees: r.conventions.rejected,
        }
      : null,
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
        spec: z
          .string()
          .optional()
          .describe(
            "Chemin d'un fichier décrivant ce qui était DEMANDÉ (ticket, cahier des charges). " +
              'Active la branche Spec : le code fait-il le travail attendu ? Sans lui, cette question ' +
              "n'est pas jugée et le résultat le déclare.",
          ),
      },
      outputSchema: {
        verdict: z.enum(['green', 'red']),
        // Requis, pas optionnel : c'est tout l'objet de J2.
        couvertureComplete: z.boolean().describe("Faux = le verdict ne porte pas sur tout le code."),
        // Requis pour la même raison, un cran plus haut : c'est l'objet de J4-a.
        jugementComplet: z
          .boolean()
          .describe(
            "Faux = une branche bloquante n'a PAS PU juger (cerveau hors contrat ou injoignable). " +
              "Un verdict 'green' avec jugementComplet=false ne signifie PAS que le code est sain : " +
              "il signifie qu'aucune vérification n'a eu lieu. Ne le rapporte jamais comme un succès.",
          ),
        jugement: z.object({
          complet: z.boolean(),
          branchesNonJugees: z.array(
            z.object({
              branche: z.string(),
              cause: z.string(),
              raison: z.string(),
              bloquante: z.boolean(),
            }),
          ),
        }),
        spec: z.object({
          fournie: z
            .boolean()
            .describe(
              "Faux = aucune spec n'a été donnée. L'audit ne dit alors RIEN sur la conformité à la " +
                "demande : ne rapporte jamais un feu vert comme « ça fait ce qui était demandé ».",
            ),
          fichier: z.string().nullable(),
          exigencesFournies: z.number(),
          exigencesNonSatisfaites: z
            .array(z.object({ id: z.string(), text: z.string() }))
            .describe('Exigences jugées non satisfaites, avec leur texte exact — cite-le à ton utilisateur.'),
          citationsRejetees: z.array(z.string()),
        }),
        conventions: z
          .object({
            documentees: z
              .boolean()
              .describe(
                "Faux = ce dépôt n'écrit AUCUNE règle. Ne rapporte alors jamais un verdict comme " +
                  "une conformité aux conventions du projet : il n'y en a pas.",
              ),
            fichiers: z.array(z.string()),
            reglesFournies: z.number().describe('Règles soumises au jugement — PAS « règles vérifiées ».'),
            reglesEcartees: z.number(),
            reglesInvoquees: z.array(z.string()).describe('Identifiants fichier:ligne cités par une trouvaille.'),
            citationsRejetees: z
              .array(z.string())
              .describe("Règles citées par le modèle qui n'existent pas dans le dépôt — signal d'hallucination."),
          })
          .nullable(),
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
    async ({ dossier, only, cap, concurrency, spec }) => {
      // (2026-08-08, faille L2-a CLOSE) Le `cap` est un PARAMÈTRE de cet appel, plus une
      // écriture dans l'environnement du process. Ce serveur est long-vivant : un seul
      // appel passant `cap` imposait auparavant sa couverture réduite à tous les
      // suivants, et deux audits concurrents se corrompaient mutuellement.
      try {
        const rapport = await auditProject(dossier, {
          concurrency: concurrency ?? 1,
          ...(cap !== undefined ? { cap } : {}),
          ...(spec !== undefined ? { spec } : {}),
          ...(only?.length ? { only } : {}),
        })
        return {
          content: [{ type: 'text' as const, text: rendreTexteMcp(rapport) }],
          structuredContent: rendreStructureMcp(rapport),
        }
      } catch (err) {
        // `auditProject` ne lève que si l'ENVIRONNEMENT est inutilisable : dossier
        // introuvable, ou cerveau incapable de rendre un verdict (fail-open partout
        // ailleurs). Erreur d'USAGE, pas un défaut d'audit — et surtout pas un
        // résultat : `isError` empêche le modèle de la lire comme « rien trouvé ».
        const cerveauMort = err instanceof CerveauInutilisableError
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: cerveauMort
                ? `Audit NON LANCÉ — ${message}\nNe conclus rien sur ce projet : il n'a pas été audité.`
                : `Audit impossible : ${message}`,
            },
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

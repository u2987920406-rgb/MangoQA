// Dialogue MCP RÉEL de bout en bout : un vrai client, un vrai process serveur,
// un vrai transport stdio. Ce test ne peut pas être unitaire — il EST le protocole.
//
// Il vérifie ce que les tests unitaires ne peuvent pas voir : que le serveur
// démarre, annonce ses outils, répond à un appel, et surtout que STDOUT ne
// transporte QUE du JSON-RPC. Un `console.log` égaré ailleurs dans le produit
// casserait ici, et nulle part ailleurs.
//
//   npx tsx tests/manual/test-mcp-stdio.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let passes = 0
let echecs = 0
function verifier(nom: string, condition: boolean, detail = ''): void {
  if (condition) {
    passes++
  } else {
    echecs++
    console.error(`  ✗ ${nom}${detail ? ` — ${detail}` : ''}`)
  }
}

// Le serveur tourne sous tsx, comme `npm run mcp`. On capture stderr pour
// vérifier que le diagnostic y va bien (et pas sur stdout).
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(racine, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(racine, 'src', 'mcp.ts')],
  cwd: racine,
  stderr: 'pipe',
})

const client = new Client({ name: 'test-mcp-stdio', version: '1.0.0' })

let stderrRecu = ''
try {
  await client.connect(transport)
  transport.stderr?.on('data', (c: Buffer) => {
    stderrRecu += c.toString()
  })

  // 1. La poignée de main a réussi : le serveur n'a rien mis d'autre sur stdout.
  //    (Si c'était le cas, `connect` aurait déjà levé une erreur de parsing.)
  verifier('poignée de main JSON-RPC', true)

  // 2. Les outils sont annoncés avec leur schéma.
  const { tools } = await client.listTools()
  const noms = tools.map(t => t.name).sort()
  verifier('2 outils annoncés', noms.length === 2, noms.join(', '))
  verifier('auditer_projet présent', noms.includes('auditer_projet'))
  verifier('lister_branches présent', noms.includes('lister_branches'))

  const audit = tools.find(t => t.name === 'auditer_projet')!
  verifier('auditer_projet a un schéma d\'entrée', Boolean(audit.inputSchema))
  verifier('auditer_projet a un schéma de SORTIE', Boolean(audit.outputSchema))

  // 3. LE point de conception : la couverture est un champ REQUIS du schéma de
  //    sortie. Un client qui valide le résultat ne peut pas obtenir un verdict
  //    sans son périmètre — c'est le défaut n°2 de J1 rendu structurellement
  //    impossible, pas seulement documenté.
  const requis = (audit.outputSchema as { required?: string[] })?.required ?? []
  verifier('`verdict` requis dans le schéma de sortie', requis.includes('verdict'), requis.join(', '))
  verifier('`couvertureComplete` REQUIS dans le schéma de sortie', requis.includes('couvertureComplete'), requis.join(', '))
  verifier('`couverture` REQUIS dans le schéma de sortie', requis.includes('couverture'), requis.join(', '))

  // 4. La description prévient le modèle. Sans ça, il relaie « feu vert » tel quel.
  verifier(
    'la description alerte sur la couverture',
    (audit.description ?? '').includes('couvertureComplete') && (audit.description ?? '').includes('COUVERTURE'),
  )

  // 5. Un appel réel — `lister_branches` ne coûte ni lecture disque ni LLM.
  const res = await client.callTool({ name: 'lister_branches', arguments: {} })
  const structure = (res as { structuredContent?: { branches?: Array<{ id: string; bloquante: boolean }> } })
    .structuredContent
  verifier('lister_branches rend un structuredContent', Boolean(structure?.branches))
  verifier('les 6 branches sont listées', structure?.branches?.length === 6, String(structure?.branches?.length))
  verifier(
    'design-system est déclarée non bloquante',
    structure?.branches?.find(b => b.id === 'design-system')?.bloquante === false,
  )

  // 6. Erreur d'usage : un dossier introuvable doit revenir en `isError`, pas
  //    faire tomber le serveur ni casser le protocole.
  const errRes = await client.callTool({ name: 'auditer_projet', arguments: { dossier: './nexiste-vraiment-pas' } })
  verifier('dossier introuvable → isError', (errRes as { isError?: boolean }).isError === true)
  const serveurVivant = await client.listTools()
  verifier('le serveur survit à une erreur d\'usage', serveurVivant.tools.length === 2)

  // 7. Le diagnostic va sur STDERR. S'il était sur stdout, rien de ce qui précède
  //    n'aurait fonctionné — mais on vérifie qu'il est bien émis quelque part.
  await new Promise(r => setTimeout(r, 200))
  verifier('bannière de démarrage sur stderr', stderrRecu.includes('serveur MCP prêt'), JSON.stringify(stderrRecu.slice(0, 120)))
} finally {
  await client.close().catch(() => {})
}

if (echecs === 0) {
  console.log(`✅ Serveur MCP (stdio) : ${passes}/${passes} passed`)
} else {
  console.error(`❌ Serveur MCP (stdio) : ${echecs} échec(s) sur ${passes + echecs}`)
  process.exit(1)
}

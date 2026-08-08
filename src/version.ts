// La version du produit, à UN seul endroit.
//
// (2026-08-08, persona P4) Elle était écrite en dur dans `cli.ts` ET dans `mcp.ts` — la
// troisième duplication de règle trouvée dans ce dépôt, après la règle de dégradation
// (lot 3) et le rendu du rapport (lot 4). Deux copies d'un numéro de version, c'est la
// garantie qu'une CLI annoncera 2.1.0 pendant qu'un serveur MCP annoncera autre chose.
export const VERSION = '2.1.0'

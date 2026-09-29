// Sonde B16 : quelle verite le lien inter-registres etablit-il, en conditions reelles ?
// (execution : npx tsx tests/manual/probe-cerveau.ts)
import { cheminRegistre, lireCerveauAuditeur, resoudreCerveauAudit } from '../../src/cerveau-partage.js'

console.log('chemin du registre :', cheminRegistre())
const c = lireCerveauAuditeur()
console.log('role « auditeur »  :', c ? `${c.provider}/${c.model}` : '(illisible)')
console.log('QA_OLLAMA_MODEL    :', process.env.QA_OLLAMA_MODEL ?? '(non fixe)')
console.log('QA_MODEL           :', process.env.QA_MODEL ?? '(non fixe)')
const r = resoudreCerveauAudit()
if (r.divergence) console.log('DIVERGENCE :', r.divergence)
else console.log('divergence : aucune')

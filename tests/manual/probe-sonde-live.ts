// Preuve LIVE de la sonde (D3/B1) : elle interroge le VRAI cerveau d'audit.
// Ecrase le resultat dans un fichier (pas de pipe : un pipe non draine bloque a 64 Ko).
import { sonderCerveauAudit, formaterSonde } from '../../src/sonde-cerveau.js'
import fs from 'node:fs'

const t0 = Date.now()
const r = await sonderCerveauAudit()
const sortie = {
  ...r,
  formatte: formaterSonde(r),
  verifie_le: new Date().toISOString(),
}
fs.writeFileSync('/home/raf/.hermes/cache/scratch/sonde-live.json', JSON.stringify(sortie, null, 2))
console.error(formaterSonde(r))
console.error(`(duree totale du script : ${Date.now() - t0} ms)`)

// Tests du lecteur JSONL partagé (#Q1). Exécution : npx tsx src/test-jsonl.ts
// Déterministe, zéro réseau, zéro LLM — disque réel (tmpdir) car c'est LE module I/O.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readJsonlTail, readJsonlSince, type JsonlCursor } from './jsonl.js'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-jsonl-'))
const file = (name: string): string => path.join(tmp, name)

interface Row {
  id: number
  tag?: string
  pad?: string
}
const row = (id: number, extra: Partial<Row> = {}): string => JSON.stringify({ id, ...extra })

// ── readJsonlTail : fichier absent → [] ──────────────────────────────────────
{
  check('tail : fichier absent → []', readJsonlTail(file('absent.jsonl')).length === 0)
}

// ── readJsonlTail : fichier petit lu EN ENTIER ───────────────────────────────
{
  const f = file('small.jsonl')
  fs.writeFileSync(f, [row(1), row(2), row(3)].join('\n') + '\n', 'utf8')
  const got = readJsonlTail<Row>(f)
  check('tail : petit fichier → toutes les lignes', got.length === 3)
  check('tail : ordre préservé', got[0].id === 1 && got[2].id === 3)
}

// ── readJsonlTail : lignes vides / corrompues ignorées ───────────────────────
{
  const f = file('dirty.jsonl')
  fs.writeFileSync(f, `${row(1)}\n\n{pas du json\n"scalaire"\n${row(2)}\n`, 'utf8')
  const got = readJsonlTail<Row>(f)
  check('tail : lignes corrompues/vides/scalaires ignorées', got.length === 2 && got[0].id === 1 && got[1].id === 2)
}

// ── readJsonlTail : fichier > cap → lecture BORNÉE par la queue ──────────────
{
  const f = file('big.jsonl')
  const pad = 'x'.repeat(100)
  const lines: string[] = []
  for (let i = 0; i < 2_000; i++) lines.push(row(i, { pad }))
  lines.push(row(999_999, { tag: 'RECENT' }))
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8')
  const size = fs.statSync(f).size
  const cap = 16 * 1024 // cap octets paramétrable, très inférieur à la taille du fichier
  const got = readJsonlTail<Row>(f, { maxBytes: cap })
  check('tail : fichier > cap → lu partiellement (queue)', size > cap && got.length > 0 && got.length < 2_001)
  check('tail : la queue garde le plus RÉCENT', got.some(r => r.tag === 'RECENT'))
  check('tail : le TOUT début (id 0) est hors queue', !got.some(r => r.id === 0))
}

// ── readJsonlTail : 1ʳᵉ ligne tronquée par le cap → JETÉE (jamais un demi-JSON) ─
{
  const f = file('truncated.jsonl')
  // 2 lignes ; cap choisi pour couper la 1ʳᵉ EN PLEIN MILIEU : elle doit être jetée.
  const l1 = row(1, { pad: 'a'.repeat(200) })
  const l2 = row(2, { tag: 'KEEP' })
  fs.writeFileSync(f, l1 + '\n' + l2 + '\n', 'utf8')
  const got = readJsonlTail<Row>(f, { maxBytes: l2.length + 1 + 50 }) // 50 octets au milieu de l1
  check('tail : ligne coupée par le cap jetée', got.length === 1 && got[0].tag === 'KEEP')
}

// ── readJsonlTail : cap nombre de lignes (les plus récentes gagnent) ─────────
{
  const f = file('lines.jsonl')
  fs.writeFileSync(f, [row(1), row(2), row(3), row(4), row(5)].join('\n') + '\n', 'utf8')
  const got = readJsonlTail<Row>(f, { maxLines: 2 })
  check('tail : maxLines garde les plus récentes', got.length === 2 && got[0].id === 4 && got[1].id === 5)
}

// ── readJsonlSince : incrémental nominal (delta uniquement) ──────────────────
{
  const f = file('incr.jsonl')
  const cursor: JsonlCursor = { offset: 0 }
  fs.writeFileSync(f, [row(1), row(2)].join('\n') + '\n', 'utf8')
  const first = readJsonlSince<Row>(f, cursor)
  check('since : 1ᵉʳ passage → tout le fichier', first.entries.length === 2 && !first.reset)
  const second = readJsonlSince<Row>(f, cursor)
  check('since : rien de neuf → []', second.entries.length === 0 && !second.reset)
  fs.appendFileSync(f, row(3) + '\n', 'utf8')
  const third = readJsonlSince<Row>(f, cursor)
  check('since : append → SEULEMENT le delta', third.entries.length === 1 && third.entries[0].id === 3)
}

// ── readJsonlSince : fin de fichier en cours d'écriture (pas de \n) relue après ─
{
  const f = file('partial.jsonl')
  const cursor: JsonlCursor = { offset: 0 }
  fs.writeFileSync(f, row(1) + '\n' + '{"id":2,"ta', 'utf8') // dernière ligne incomplète
  const a = readJsonlSince<Row>(f, cursor)
  check('since : ligne incomplète NON consommée', a.entries.length === 1 && a.entries[0].id === 1)
  fs.appendFileSync(f, 'g":"END"}\n', 'utf8') // la ligne se termine
  const b = readJsonlSince<Row>(f, cursor)
  check('since : ligne complétée lue au passage suivant', b.entries.length === 1 && b.entries[0].tag === 'END')
}

// ── readJsonlSince : rotation (fichier rétréci) → reset + relecture ──────────
{
  const f = file('rotate.jsonl')
  const cursor: JsonlCursor = { offset: 0 }
  fs.writeFileSync(f, [row(1), row(2), row(3)].join('\n') + '\n', 'utf8')
  readJsonlSince<Row>(f, cursor)
  fs.writeFileSync(f, row(9) + '\n', 'utf8') // rotation : fichier plus PETIT
  const got = readJsonlSince<Row>(f, cursor)
  check('since : fichier rétréci → reset signalé', got.reset)
  check('since : après rotation, relit depuis zéro', got.entries.length === 1 && got.entries[0].id === 9)
}

// ── readJsonlSince : fichier disparu → reset, puis absent → [] sans reset ────
{
  const f = file('gone.jsonl')
  const cursor: JsonlCursor = { offset: 0 }
  fs.writeFileSync(f, row(1) + '\n', 'utf8')
  readJsonlSince<Row>(f, cursor)
  fs.rmSync(f)
  const a = readJsonlSince<Row>(f, cursor)
  check('since : fichier disparu → reset + []', a.reset && a.entries.length === 0)
  const b = readJsonlSince<Row>(f, cursor)
  check('since : toujours absent → [] sans nouveau reset', !b.reset && b.entries.length === 0)
}

// ── readJsonlSince : delta > cap octets → saut borné + 1ʳᵉ ligne tronquée jetée ─
{
  const f = file('bigdelta.jsonl')
  const cursor: JsonlCursor = { offset: 0 }
  const pad = 'z'.repeat(100)
  const lines: string[] = []
  for (let i = 0; i < 1_000; i++) lines.push(row(i, { pad }))
  lines.push(row(777, { tag: 'RECENT' }))
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8')
  const got = readJsonlSince<Row>(f, cursor, { maxBytes: 8 * 1024 })
  check('since : delta > cap → lecture bornée', got.entries.length > 0 && got.entries.length < 1_001)
  check('since : la queue du delta garde le plus récent', got.entries.some(r => r.tag === 'RECENT'))
  check('since : le début du delta est sauté', !got.entries.some(r => r.id === 0))
  const again = readJsonlSince<Row>(f, cursor, { maxBytes: 8 * 1024 })
  check('since : curseur avancé après saut borné', again.entries.length === 0)
}

fs.rmSync(tmp, { recursive: true, force: true })

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[jsonl] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)

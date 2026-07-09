// Tests du lecteur JSONL partagé (#Q1).
// Déterministe, zéro réseau, zéro LLM — disque réel (tmpdir) car c'est LE module I/O.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readJsonlTail, readJsonlSince, type JsonlCursor } from '../../src/jsonl.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-jsonl-'))
const file = (name: string): string => path.join(tmp, name)

interface Row {
  id: number
  tag?: string
  pad?: string
}
const row = (id: number, extra: Partial<Row> = {}): string => JSON.stringify({ id, ...extra })

describe('jsonl', () => {
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('tail : fichier absent → []', () => {
    expect(readJsonlTail(file('absent.jsonl')).length).toBe(0)
  })

  it('tail : petit fichier → toutes les lignes, ordre préservé', () => {
    const f = file('small.jsonl')
    fs.writeFileSync(f, [row(1), row(2), row(3)].join('\n') + '\n', 'utf8')
    const got = readJsonlTail<Row>(f)
    expect(got.length).toBe(3)
    expect(got[0].id === 1 && got[2].id === 3).toBe(true)
  })

  it('tail : lignes corrompues/vides/scalaires ignorées', () => {
    const f = file('dirty.jsonl')
    fs.writeFileSync(f, `${row(1)}\n\n{pas du json\n"scalaire"\n${row(2)}\n`, 'utf8')
    const got = readJsonlTail<Row>(f)
    expect(got.length === 2 && got[0].id === 1 && got[1].id === 2).toBe(true)
  })

  it('tail : fichier > cap → lecture bornée (queue) qui garde le plus récent', () => {
    const f = file('big.jsonl')
    const pad = 'x'.repeat(100)
    const lines: string[] = []
    for (let i = 0; i < 2_000; i++) lines.push(row(i, { pad }))
    lines.push(row(999_999, { tag: 'RECENT' }))
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8')
    const size = fs.statSync(f).size
    const cap = 16 * 1024 // cap octets paramétrable, très inférieur à la taille du fichier
    const got = readJsonlTail<Row>(f, { maxBytes: cap })
    expect(size > cap && got.length > 0 && got.length < 2_001).toBe(true)
    expect(got.some(r => r.tag === 'RECENT')).toBe(true)
    expect(got.some(r => r.id === 0)).toBe(false)
  })

  it('tail : 1ʳᵉ ligne tronquée par le cap → jetée (jamais un demi-JSON)', () => {
    const f = file('truncated.jsonl')
    // 2 lignes ; cap choisi pour couper la 1ʳᵉ EN PLEIN MILIEU : elle doit être jetée.
    const l1 = row(1, { pad: 'a'.repeat(200) })
    const l2 = row(2, { tag: 'KEEP' })
    fs.writeFileSync(f, l1 + '\n' + l2 + '\n', 'utf8')
    const got = readJsonlTail<Row>(f, { maxBytes: l2.length + 1 + 50 }) // 50 octets au milieu de l1
    expect(got.length === 1 && got[0].tag === 'KEEP').toBe(true)
  })

  it('tail : cap nombre de lignes garde les plus récentes', () => {
    const f = file('lines.jsonl')
    fs.writeFileSync(f, [row(1), row(2), row(3), row(4), row(5)].join('\n') + '\n', 'utf8')
    const got = readJsonlTail<Row>(f, { maxLines: 2 })
    expect(got.length === 2 && got[0].id === 4 && got[1].id === 5).toBe(true)
  })

  it('since : incrémental nominal (delta uniquement)', () => {
    const f = file('incr.jsonl')
    const cursor: JsonlCursor = { offset: 0 }
    fs.writeFileSync(f, [row(1), row(2)].join('\n') + '\n', 'utf8')
    const first = readJsonlSince<Row>(f, cursor)
    expect(first.entries.length === 2 && !first.reset).toBe(true)
    const second = readJsonlSince<Row>(f, cursor)
    expect(second.entries.length === 0 && !second.reset).toBe(true)
    fs.appendFileSync(f, row(3) + '\n', 'utf8')
    const third = readJsonlSince<Row>(f, cursor)
    expect(third.entries.length === 1 && third.entries[0].id === 3).toBe(true)
  })

  it('since : fin de fichier en cours d\'écriture (pas de \\n) relue après', () => {
    const f = file('partial.jsonl')
    const cursor: JsonlCursor = { offset: 0 }
    fs.writeFileSync(f, row(1) + '\n' + '{"id":2,"ta', 'utf8') // dernière ligne incomplète
    const a = readJsonlSince<Row>(f, cursor)
    expect(a.entries.length === 1 && a.entries[0].id === 1).toBe(true)
    fs.appendFileSync(f, 'g":"END"}\n', 'utf8') // la ligne se termine
    const b = readJsonlSince<Row>(f, cursor)
    expect(b.entries.length === 1 && b.entries[0].tag === 'END').toBe(true)
  })

  it('since : rotation (fichier rétréci) → reset + relecture depuis zéro', () => {
    const f = file('rotate.jsonl')
    const cursor: JsonlCursor = { offset: 0 }
    fs.writeFileSync(f, [row(1), row(2), row(3)].join('\n') + '\n', 'utf8')
    readJsonlSince<Row>(f, cursor)
    fs.writeFileSync(f, row(9) + '\n', 'utf8') // rotation : fichier plus PETIT
    const got = readJsonlSince<Row>(f, cursor)
    expect(got.reset).toBe(true)
    expect(got.entries.length === 1 && got.entries[0].id === 9).toBe(true)
  })

  it('since : fichier disparu → reset, puis absent → [] sans nouveau reset', () => {
    const f = file('gone.jsonl')
    const cursor: JsonlCursor = { offset: 0 }
    fs.writeFileSync(f, row(1) + '\n', 'utf8')
    readJsonlSince<Row>(f, cursor)
    fs.rmSync(f)
    const a = readJsonlSince<Row>(f, cursor)
    expect(a.reset && a.entries.length === 0).toBe(true)
    const b = readJsonlSince<Row>(f, cursor)
    expect(!b.reset && b.entries.length === 0).toBe(true)
  })

  it('since : delta > cap octets → saut borné + 1ʳᵉ ligne tronquée jetée', () => {
    const f = file('bigdelta.jsonl')
    const cursor: JsonlCursor = { offset: 0 }
    const pad = 'z'.repeat(100)
    const lines: string[] = []
    for (let i = 0; i < 1_000; i++) lines.push(row(i, { pad }))
    lines.push(row(777, { tag: 'RECENT' }))
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8')
    const got = readJsonlSince<Row>(f, cursor, { maxBytes: 8 * 1024 })
    expect(got.entries.length > 0 && got.entries.length < 1_001).toBe(true)
    expect(got.entries.some(r => r.tag === 'RECENT')).toBe(true)
    expect(got.entries.some(r => r.id === 0)).toBe(false)
    const again = readJsonlSince<Row>(f, cursor, { maxBytes: 8 * 1024 })
    expect(again.entries.length).toBe(0)
  })
})

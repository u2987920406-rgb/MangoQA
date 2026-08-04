// J0 — CORPUS D'ÉVALUATION ÉTIQUETÉ de Mango QA.
//
// Pourquoi ce fichier existe (2026-08-04, refonte produit) : on sait que le
// mécanisme d'audit TOURNE, on ne sait pas s'il a RAISON. Le README de MangoQA
// dit lui-même que les prompts et seuils des 6 branches sont une réimplémentation
// (reconstruction du 2026-06-19) jamais mesurée contre un corpus. Et la sonde
// MangoOS du 2026-07-24 a mesuré 1 raté sur 4 défauts connus rejoués.
//
// Sortir un auditeur dont on ignore le taux d'erreur serait exactement la faute
// qu'on reproche aux générateurs d'apps IA. Ce corpus est le préalable.
//
// PRINCIPE — chaque cas porte une VÉRITÉ TERRAIN explicite :
//   • un défaut INJECTÉ, connu, localisé, d'un type que les générateurs IA
//     produisent réellement ;
//   • le verdict ATTENDU pour chaque branche qu'on veut noter (`expect`) ;
//   • des CONTRÔLES PROPRES (aucun défaut) pour mesurer les faux positifs —
//     sans eux, un auditeur qui dit toujours "fail" obtiendrait 100 % de détection.
//
// Le corpus vit EN MÉMOIRE (ProjectFile[]), jamais sur disque : les branches
// prennent déjà `{ path, content }` — aucun fichier temporaire, aucun nettoyage,
// exécution reproductible.

import type { ProjectFile } from '../src/types.js'

/** Les 6 branches notables (ids réels de src/branches/*.ts). */
export type BranchId =
  | 'architecture'
  | 'security'
  | 'accessibility'
  | 'performance'
  | 'tests'
  | 'design-system'

export interface EvalCase {
  id: string
  /** Ce qui a été injecté (ou « rien » pour un contrôle propre). */
  defect: string
  /** Où, pour qu'un humain puisse vérifier le verdict à la main. */
  location?: string
  /** Règle de référence attendue (indicatif — non noté automatiquement). */
  rule?: string
  /**
   * Vérité terrain. SEULES les branches listées sont notées.
   * Une branche absente n'est ni comptée en détection ni en faux positif —
   * on ne note que ce qu'on est sûr d'affirmer.
   */
  expect: Partial<Record<BranchId, 'fail' | 'pass'>>
  /**
   * Pour les branches de CONSEIL (design-system ne peut jamais renvoyer 'fail') :
   * mots-clés dont au moins un doit apparaître dans le résumé pour compter
   * comme « repéré ». Insensible à la casse et aux accents.
   */
  expectMentions?: Partial<Record<BranchId, string[]>>
  /** Signal projet passé à la branche Tests (elle en dépend explicitement). */
  testsElsewhereInProject?: boolean
  files: ProjectFile[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 SÉCURITÉ — 5 cas
// ─────────────────────────────────────────────────────────────────────────────

const SECURITY: EvalCase[] = [
  {
    id: 'SEC-01-cle-service-exposee',
    defect: 'Clé de SERVICE Supabase préfixée VITE_ → inlinée dans le bundle client.',
    location: 'src/lib/db.ts:4',
    rule: 'OWASP A05 — Security Misconfiguration',
    expect: { security: 'fail', accessibility: 'pass' },
    files: [
      {
        path: 'src/lib/db.ts',
        content: `import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const SERVICE_KEY = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY

export const db = createClient(URL, SERVICE_KEY)

export async function listOrders() {
  const { data } = await db.from('orders').select('*')
  return data ?? []
}
`,
      },
    ],
  },
  {
    id: 'SEC-02-xss-innerhtml',
    defect: 'dangerouslySetInnerHTML alimenté par une donnée utilisateur non assainie.',
    location: 'src/components/Comment.tsx:9',
    rule: 'OWASP A03 — Injection (XSS)',
    expect: { security: 'fail' },
    files: [
      {
        path: 'src/components/Comment.tsx',
        content: `type Props = { author: string; bodyHtml: string }

export default function Comment({ author, bodyHtml }: Props) {
  return (
    <article className="comment">
      <h4>{author}</h4>
      <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
    </article>
  )
}
`,
      },
      {
        path: 'src/api/comments.ts',
        content: `import { db } from '../lib/store.js'

// bodyHtml vient directement du formulaire public, aucun assainissement.
export async function addComment(author: string, bodyHtml: string) {
  return db.comments.insert({ author, bodyHtml })
}
`,
      },
    ],
  },
  {
    id: 'SEC-03-injection-sql',
    defect: 'Requête SQL construite par concaténation depuis req.query.',
    location: 'server/routes/search.js:7',
    rule: 'OWASP A03 — Injection',
    expect: { security: 'fail' },
    files: [
      {
        path: 'server/routes/search.js',
        content: `import { pool } from '../db.js'

export function searchRoute(app) {
  app.get('/api/search', async (req, res) => {
    const term = req.query.q
    const sql = "SELECT id, title FROM products WHERE title LIKE '%" + term + "%'"
    const { rows } = await pool.query(sql)
    res.json(rows)
  })
}
`,
      },
    ],
  },
  {
    id: 'SEC-04-cors-wildcard',
    defect: "CORS origin '*' avec credentials sur une API authentifiée.",
    location: 'server/index.js:8',
    rule: 'OWASP A05 — Security Misconfiguration',
    expect: { security: 'fail' },
    files: [
      {
        path: 'server/index.js',
        content: `import express from 'express'
import cors from 'cors'
import { requireSession } from './auth.js'

const app = express()

app.use(cors({ origin: '*', credentials: true }))

app.get('/api/me', requireSession, (req, res) => {
  res.json({ email: req.session.email, role: req.session.role })
})

app.listen(3000)
`,
      },
    ],
  },
  {
    id: 'SEC-05-path-traversal',
    defect: "Chemin de fichier construit depuis req.params sans validation (traversal ../).",
    location: 'server/routes/files.js:8',
    rule: 'OWASP A01 — Broken Access Control',
    expect: { security: 'fail' },
    files: [
      {
        path: 'server/routes/files.js',
        content: `import fs from 'node:fs'
import path from 'node:path'

const UPLOADS = path.join(process.cwd(), 'uploads')

export function fileRoute(app) {
  app.get('/api/file/:name', (req, res) => {
    const target = path.join(UPLOADS, req.params.name)
    res.send(fs.readFileSync(target, 'utf8'))
  })
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ♿ ACCESSIBILITÉ — 4 cas
// ─────────────────────────────────────────────────────────────────────────────

const ACCESSIBILITY: EvalCase[] = [
  {
    id: 'A11Y-01-contraste',
    defect: 'Texte #9a9a9a sur fond #ffffff → ratio ≈ 2.8:1 (seuil AA : 4.5:1).',
    location: 'src/components/Nav.tsx:6',
    rule: 'WCAG 1.4.3 — Contrast (Minimum)',
    expect: { accessibility: 'fail' },
    files: [
      {
        path: 'src/components/Nav.tsx',
        content: `export default function Nav() {
  return (
    <nav style={{ background: '#ffffff' }}>
      <a href="/" style={{ color: '#9a9a9a' }}>Accueil</a>
      <a href="/boutique" style={{ color: '#9a9a9a' }}>Boutique</a>
      <a href="/contact" style={{ color: '#9a9a9a' }}>Contact</a>
    </nav>
  )
}
`,
      },
    ],
  },
  {
    id: 'A11Y-02-img-sans-alt',
    defect: 'Images de contenu sans attribut alt.',
    location: 'src/components/Gallery.tsx:7',
    rule: 'WCAG 1.1.1 — Non-text Content',
    expect: { accessibility: 'fail' },
    files: [
      {
        path: 'src/components/Gallery.tsx',
        content: `type Photo = { id: string; url: string; legende: string }

export default function Gallery({ photos }: { photos: Photo[] }) {
  return (
    <div className="grid">
      {photos.map((p) => (
        <figure key={p.id}>
          <img src={p.url} width={320} height={240} />
          <figcaption>{p.legende}</figcaption>
        </figure>
      ))}
    </div>
  )
}
`,
      },
    ],
  },
  {
    id: 'A11Y-03-div-cliquable',
    defect: 'div avec onClick, sans role, sans tabIndex, sans gestion clavier.',
    location: 'src/components/Card.tsx:5',
    rule: 'WCAG 2.1.1 — Keyboard',
    expect: { accessibility: 'fail' },
    files: [
      {
        path: 'src/components/Card.tsx',
        content: `type Props = { titre: string; onOpen: () => void }

export default function Card({ titre, onOpen }: Props) {
  return (
    <div className="card" onClick={onOpen}>
      <h3>{titre}</h3>
      <span className="chevron">›</span>
    </div>
  )
}
`,
      },
    ],
  },
  {
    id: 'A11Y-04-input-sans-label',
    defect: 'Champs de formulaire sans <label> associé (placeholder seul).',
    location: 'src/components/Signup.tsx:6',
    rule: 'WCAG 3.3.2 — Labels or Instructions',
    expect: { accessibility: 'fail' },
    files: [
      {
        path: 'src/components/Signup.tsx',
        content: `export default function Signup({ onSubmit }: { onSubmit: (e: any) => void }) {
  return (
    <form onSubmit={onSubmit}>
      <input type="email" placeholder="Votre email" />
      <input type="password" placeholder="Mot de passe" />
      <button type="submit">Créer mon compte</button>
    </form>
  )
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 🏗️ ARCHITECTURE — 3 cas
// ─────────────────────────────────────────────────────────────────────────────

const ARCHITECTURE: EvalCase[] = [
  {
    id: 'ARCH-01-monolithe',
    defect: 'Un seul composant mêle fetch réseau, état, logique métier et rendu.',
    location: 'src/Dashboard.tsx (fichier entier)',
    expect: { architecture: 'fail' },
    files: [
      {
        path: 'src/Dashboard.tsx',
        content: `import { useEffect, useState } from 'react'

export default function Dashboard() {
  const [orders, setOrders] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState('date')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/orders').then(r => r.json()).then(setOrders)
      .then(() => fetch('/api/users').then(r => r.json()).then(setUsers))
      .then(() => fetch('/api/invoices').then(r => r.json()).then(setInvoices))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Calcul de TVA
  function tva(montantHT: number, taux: number) {
    return Math.round(montantHT * taux * 100) / 100
  }
  // Remise par palier
  function remise(total: number) {
    if (total > 1000) return total * 0.9
    if (total > 500) return total * 0.95
    return total
  }
  // Formatage monétaire
  function euros(n: number) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n)
  }
  // Statut lisible
  function statut(o: any) {
    if (o.paid && o.shipped) return 'Livrée'
    if (o.paid) return 'Payée'
    if (o.cancelled) return 'Annulée'
    return 'En attente'
  }

  const visibles = orders
    .filter(o => !filter || statut(o) === filter)
    .sort((a, b) => (sort === 'date' ? b.date - a.date : b.total - a.total))
    .slice(page * 20, page * 20 + 20)

  if (loading) return <p>Chargement…</p>
  if (error) return <p>Erreur : {error}</p>

  return (
    <div>
      <header>
        <input value={filter} onChange={e => setFilter(e.target.value)} />
        <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="date">Date</option>
          <option value="total">Total</option>
        </select>
      </header>
      <table>
        <tbody>
          {visibles.map(o => (
            <tr key={o.id}>
              <td>{o.ref}</td>
              <td>{users.find(u => u.id === o.userId)?.name}</td>
              <td>{statut(o)}</td>
              <td>{euros(remise(o.total))}</td>
              <td>{euros(tva(o.total, 0.2))}</td>
              <td>{invoices.filter(i => i.orderId === o.id).length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <button onClick={() => setPage(p => Math.max(0, p - 1))}>Précédent</button>
        <button onClick={() => setPage(p => p + 1)}>Suivant</button>
      </footer>
    </div>
  )
}
`,
      },
    ],
  },
  {
    id: 'ARCH-02-duplication',
    defect: 'La même fonction de formatage de prix est recopiée dans 3 fichiers.',
    location: 'src/pages/{Panier,Commande,Facture}.tsx',
    expect: { architecture: 'fail' },
    files: [
      {
        path: 'src/pages/Panier.tsx',
        content: `function formatPrix(cents: number) {
  const euros = cents / 100
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(euros)
}

export default function Panier({ lignes }: { lignes: any[] }) {
  const total = lignes.reduce((s, l) => s + l.prixCents * l.qte, 0)
  return <p>Total : {formatPrix(total)}</p>
}
`,
      },
      {
        path: 'src/pages/Commande.tsx',
        content: `function formatPrix(cents: number) {
  const euros = cents / 100
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(euros)
}

export default function Commande({ commande }: { commande: any }) {
  return <p>Payé : {formatPrix(commande.totalCents)}</p>
}
`,
      },
      {
        path: 'src/pages/Facture.tsx',
        content: `function formatPrix(cents: number) {
  const euros = cents / 100
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(euros)
}

export default function Facture({ facture }: { facture: any }) {
  return <p>Montant dû : {formatPrix(facture.dueCents)}</p>
}
`,
      },
    ],
  },
  {
    id: 'ARCH-03-couplage-ui-db',
    defect: 'Un composant de présentation importe et interroge directement le client base de données.',
    location: 'src/components/UserBadge.tsx:2',
    expect: { architecture: 'fail' },
    files: [
      {
        path: 'src/components/UserBadge.tsx',
        content: `import { useEffect, useState } from 'react'
import { pool } from '../../server/db.js'

export default function UserBadge({ id }: { id: string }) {
  const [name, setName] = useState('')
  useEffect(() => {
    pool.query('SELECT name FROM users WHERE id = $1', [id]).then((r: any) => setName(r.rows[0]?.name ?? ''))
  }, [id])
  return <span className="badge">{name}</span>
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ⚡ PERFORMANCE — 3 cas
// ─────────────────────────────────────────────────────────────────────────────

const PERFORMANCE: EvalCase[] = [
  {
    id: 'PERF-01-liste-non-virtualisee',
    defect: 'Rendu de 5 000 lignes sans virtualisation ni pagination.',
    location: 'src/components/BigList.tsx:8',
    expect: { performance: 'fail' },
    files: [
      {
        path: 'src/components/BigList.tsx',
        content: `type Row = { id: string; label: string; valeur: number }

// products contient ~5000 entrées chargées d'un coup depuis /api/products
export default function BigList({ products }: { products: Row[] }) {
  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>
          <span>{p.label}</span>
          <strong>{p.valeur}</strong>
        </li>
      ))}
    </ul>
  )
}
`,
      },
    ],
  },
  {
    id: 'PERF-02-useeffect-boucle',
    defect: 'useEffect sans tableau de dépendances → refetch à chaque rendu (boucle réseau).',
    location: 'src/components/Profil.tsx:7',
    expect: { performance: 'fail' },
    files: [
      {
        path: 'src/components/Profil.tsx',
        content: `import { useEffect, useState } from 'react'

export default function Profil({ id }: { id: string }) {
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    fetch('/api/users/' + id).then(r => r.json()).then(setUser)
  })

  if (!user) return null
  return <h2>{user.name}</h2>
}
`,
      },
    ],
  },
  {
    id: 'PERF-03-import-lourd',
    defect: 'Import de lodash entier et de moment pour une seule fonction chacun.',
    location: 'src/utils/format.ts:1',
    expect: { performance: 'fail' },
    files: [
      {
        path: 'src/utils/format.ts',
        content: `import _ from 'lodash'
import moment from 'moment'

export function unique(ids: string[]) {
  return _.uniq(ids)
}

export function jour(d: Date) {
  return moment(d).format('DD/MM/YYYY')
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 🧪 TESTS — 2 cas (dont 1 contrôle positif)
// ─────────────────────────────────────────────────────────────────────────────

const TESTS: EvalCase[] = [
  {
    id: 'TEST-01-logique-non-testee',
    defect: 'Logique métier non triviale (paliers de remise + TVA) sans aucun test dans le projet.',
    location: 'src/domain/facturation.ts',
    expect: { tests: 'fail' },
    testsElsewhereInProject: false,
    files: [
      {
        path: 'src/domain/facturation.ts',
        content: `export interface Ligne { prixCents: number; qte: number; categorie: 'standard' | 'reduit' }

const TAUX = { standard: 0.2, reduit: 0.055 }

export function remise(totalCents: number): number {
  if (totalCents >= 100_000) return Math.round(totalCents * 0.85)
  if (totalCents >= 50_000) return Math.round(totalCents * 0.9)
  if (totalCents >= 20_000) return Math.round(totalCents * 0.95)
  return totalCents
}

export function totalTTC(lignes: Ligne[]): number {
  const ht = lignes.reduce((s, l) => s + l.prixCents * l.qte, 0)
  const remise_ = remise(ht)
  const tva = lignes.reduce((s, l) => s + l.prixCents * l.qte * TAUX[l.categorie], 0)
  return Math.round(remise_ + tva)
}
`,
      },
    ],
  },
  {
    id: 'TEST-02-controle-logique-testee',
    defect: 'CONTRÔLE POSITIF — même logique métier, avec ses tests. Ne doit PAS être rejetée.',
    expect: { tests: 'pass' },
    testsElsewhereInProject: true,
    files: [
      {
        path: 'src/domain/facturation.ts',
        content: `export function remise(totalCents: number): number {
  if (totalCents >= 100_000) return Math.round(totalCents * 0.85)
  if (totalCents >= 50_000) return Math.round(totalCents * 0.9)
  return totalCents
}
`,
      },
      {
        path: 'src/domain/facturation.test.ts',
        content: `import { describe, it, expect } from 'vitest'
import { remise } from './facturation.js'

describe('remise', () => {
  it('applique -15% au-delà de 1000 €', () => {
    expect(remise(100_000)).toBe(85_000)
  })
  it('applique -10% au-delà de 500 €', () => {
    expect(remise(50_000)).toBe(45_000)
  })
  it('ne remise pas en dessous du palier', () => {
    expect(remise(49_999)).toBe(49_999)
  })
})
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 🎨 DESIGN SYSTEM — 2 cas (branche de CONSEIL : ne peut jamais renvoyer 'fail')
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_SYSTEM: EvalCase[] = [
  {
    id: 'DS-01-couleurs-hors-palette',
    defect: '7 valeurs hexadécimales en dur, aucune ne vient des tokens du design system.',
    location: 'src/components/Promo.tsx',
    // Branche de conseil → on ne note pas 'fail', on note si elle REPÈRE.
    expect: { 'design-system': 'pass' },
    expectMentions: { 'design-system': ['couleur', 'palette', 'token', 'hex', 'en dur', 'hardcod'] },
    files: [
      {
        path: 'src/tokens.css',
        content: `:root {
  --brand: #ff9500;
  --ink: #1c1c1e;
  --surface: #ffffff;
  --muted: #6b7280;
}
`,
      },
      {
        path: 'src/components/Promo.tsx',
        content: `export default function Promo() {
  return (
    <section style={{ background: '#fef3c7', border: '1px solid #fbbf24' }}>
      <h2 style={{ color: '#7c2d12' }}>Offre du moment</h2>
      <p style={{ color: '#92400e' }}>-20 % sur tout le catalogue</p>
      <button style={{ background: '#f97316', color: '#fffbeb', borderColor: '#ea580c' }}>
        J'en profite
      </button>
    </section>
  )
}
`,
      },
    ],
  },
  {
    id: 'DS-02-espacements-arbitraires',
    defect: 'Espacements arbitraires (13px, 27px, 7px) hors échelle 4/8.',
    location: 'src/components/Panneau.tsx',
    expect: { 'design-system': 'pass' },
    expectMentions: { 'design-system': ['espacement', 'spacing', 'échelle', 'echelle', 'marge', 'padding'] },
    files: [
      {
        path: 'src/components/Panneau.tsx',
        content: `export default function Panneau({ children }: { children: any }) {
  return (
    <div style={{ padding: '13px 27px', marginBottom: 7, gap: 11 }}>
      {children}
    </div>
  )
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ✅ CONTRÔLES PROPRES — 4 cas. Aucun défaut. Toute 'fail' = FAUX POSITIF.
//
// Sans eux, un auditeur qui répondrait « fail » à tout obtiendrait 100 % de
// détection. C'est la moitié de la mesure, pas un supplément.
// ─────────────────────────────────────────────────────────────────────────────

const CLEAN: EvalCase[] = [
  {
    id: 'CLEAN-01-composant-propre',
    defect: 'RIEN — composant accessible, découpé, sans secret, sans coût.',
    expect: {
      architecture: 'pass',
      security: 'pass',
      accessibility: 'pass',
      performance: 'pass',
    },
    testsElsewhereInProject: true,
    files: [
      {
        path: 'src/components/AlerteStock.tsx',
        content: `import { formatPrix } from '../utils/prix.js'

export interface AlerteStockProps {
  produit: string
  restant: number
  prixCents: number
  onCommander: () => void
}

export default function AlerteStock({ produit, restant, prixCents, onCommander }: AlerteStockProps) {
  return (
    <aside role="status" aria-live="polite" className="alerte-stock">
      <p>
        Il reste <strong>{restant}</strong> unité(s) de {produit} à {formatPrix(prixCents)}.
      </p>
      <button type="button" onClick={onCommander}>
        Commander maintenant
      </button>
    </aside>
  )
}
`,
      },
      {
        path: 'src/utils/prix.ts',
        content: `export function formatPrix(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
`,
      },
    ],
  },
  {
    id: 'CLEAN-02-route-api-sure',
    defect: 'RIEN — route Express avec requête paramétrée, CORS restreint, chemin validé.',
    expect: { security: 'pass', architecture: 'pass', performance: 'pass' },
    files: [
      {
        path: 'server/routes/produits.js',
        content: `import { pool } from '../db.js'

export function produitsRoute(app) {
  app.get('/api/produits', async (req, res) => {
    const terme = String(req.query.q ?? '').slice(0, 80)
    const { rows } = await pool.query(
      'SELECT id, titre, prix_cents FROM produits WHERE titre ILIKE $1 LIMIT 50',
      ['%' + terme + '%'],
    )
    res.json(rows)
  })
}
`,
      },
      {
        path: 'server/cors.js',
        content: `import cors from 'cors'

const ORIGINES = ['https://boutique.example.com', 'http://localhost:5173']

export const corsStrict = cors({
  origin: (origin, cb) => cb(null, !origin || ORIGINES.includes(origin)),
  credentials: true,
})
`,
      },
    ],
  },
  {
    id: 'CLEAN-03-formulaire-accessible',
    defect: 'RIEN — formulaire entièrement étiqueté, erreurs annoncées, contraste conforme.',
    expect: { accessibility: 'pass', architecture: 'pass' },
    files: [
      {
        path: 'src/components/Connexion.tsx',
        content: `type Props = { erreur?: string; onSubmit: (e: React.FormEvent) => void }

export default function Connexion({ erreur, onSubmit }: Props) {
  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="email">Adresse email</label>
      <input id="email" name="email" type="email" autoComplete="email" required
             aria-describedby={erreur ? 'erreur-form' : undefined} />

      <label htmlFor="mdp">Mot de passe</label>
      <input id="mdp" name="mdp" type="password" autoComplete="current-password" required />

      {erreur && <p id="erreur-form" role="alert">{erreur}</p>}

      <button type="submit">Se connecter</button>
    </form>
  )
}
`,
      },
      {
        path: 'src/styles/form.css',
        content: `/* #1c1c1e sur #ffffff → ratio 16.1:1 (AAA) */
form label { color: #1c1c1e; background: #ffffff; }
form [role='alert'] { color: #b42318; background: #ffffff; } /* ratio 5.9:1 (AA) */
`,
      },
    ],
  },
  {
    id: 'CLEAN-04-liste-paginee',
    defect: 'RIEN — liste paginée côté serveur, dépendances explicites, imports ciblés.',
    expect: { performance: 'pass', architecture: 'pass' },
    files: [
      {
        path: 'src/components/ListeProduits.tsx',
        content: `import { useEffect, useState } from 'react'
import { uniq } from '../utils/collections.js'

const PAR_PAGE = 25

export default function ListeProduits({ page }: { page: number }) {
  const [items, setItems] = useState<Array<{ id: string; titre: string }>>([])

  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/produits?page=' + page + '&limit=' + PAR_PAGE, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => setItems(uniq(data, (p: any) => p.id)))
      .catch(() => {})
    return () => ctrl.abort()
  }, [page])

  return (
    <ul>
      {items.map((p) => (
        <li key={p.id}>{p.titre}</li>
      ))}
    </ul>
  )
}
`,
      },
      {
        path: 'src/utils/collections.ts',
        content: `export function uniq<T>(items: T[], key: (item: T) => string): T[] {
  const vus = new Set<string>()
  return items.filter((it) => {
    const k = key(it)
    if (vus.has(k)) return false
    vus.add(k)
    return true
  })
}
`,
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────

export const CORPUS: EvalCase[] = [
  ...SECURITY,
  ...ACCESSIBILITY,
  ...ARCHITECTURE,
  ...PERFORMANCE,
  ...TESTS,
  ...DESIGN_SYSTEM,
  ...CLEAN,
]

/** Répartition du corpus, pour l'en-tête du rapport. */
export function corpusSummary(): { total: number; defauts: number; propres: number } {
  const propres = CORPUS.filter((c) => c.id.startsWith('CLEAN-')).length
  return { total: CORPUS.length, defauts: CORPUS.length - propres, propres }
}

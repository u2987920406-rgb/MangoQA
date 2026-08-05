// Tests de la COUVERTURE d'audit (J1 défaut n°2 — l'audit partiel silencieux).
// Déterministe, zéro réseau, zéro LLM : le cerveau est injecté (`ask`) et on
// inspecte le prompt qu'il reçoit.
//
// Ce que ces tests protègent : « Un auditeur a le droit de ne pas tout lire ;
// il n'a pas le droit de le taire. » Deux obligations distinctes —
//  1. le DIRE AU MODÈLE (sinon il conclut par absence sur du code qu'il n'a pas vu) ;
//  2. le DIRE EN AVAL (sinon le rapport et le verdict présentent un audit partiel
//     comme un audit complet).
import { describe, it, expect } from 'vitest'
import { auditWithLLM, type BranchMeta } from '../../src/llm.js'
import type { AuditContext, ProjectFile } from '../../src/types.js'

const META: BranchMeta = { id: 'architecture', specialty: 'Spécialité : ARCHITECTURE.' }

function ctxWith(files: ProjectFile[]): AuditContext {
  return {
    signal: {
      projectName: 'projet-test',
      phase: 'audit',
      timestamp: '2026-08-05T00:00:00.000Z',
      projectDir: '/p',
      changedFiles: files.map(f => f.path),
      retryCount: 0,
    },
    files,
    retex: '',
  }
}

/** Cerveau factice : capture le prompt reçu et répond un verdict fixe. */
function spyBrain(response = JSON.stringify({ status: 'pass', summary: 'RAS' })) {
  const prompts: string[] = []
  const ask = async (_system: string, user: string): Promise<string> => {
    prompts.push(user)
    return response
  }
  return { ask, prompts }
}

/** n fichiers de `chars` caractères — de quoi déborder n'importe quel cap. */
function bigFiles(n: number, chars: number): ProjectFile[] {
  return Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x'.repeat(chars) }))
}

describe('auditWithLLM — couverture déclarée', () => {
  describe('1. le prompt dit au modèle ce qu\'il ne voit PAS', () => {
    it('lecture partielle → le prompt annonce le ratio ET interdit le raisonnement par absence', async () => {
      // 40 fichiers × 20 000 car. = 800 000 car. : très au-delà de tout cap réaliste.
      const brain = spyBrain()
      await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), brain.ask)
      const prompt = brain.prompts[0]
      expect(prompt).toContain('COUVERTURE DE CETTE LECTURE')
      expect(prompt).toMatch(/tu ne vois que \d+ des 40 fichiers pertinents/)
      expect(prompt).toContain('Fichiers NON fournis')
      // Le point qui désamorce le faux positif fabriqué par notre propre cap.
      expect(prompt).toContain("ne conclus rien d'une absence constatée DANS CES FICHIERS")
    })

    // Garde-fou appris au premier run réel : l'interdiction de conclure par absence ne
    // doit pas écraser un « Signal projet », qui vient d'un balayage COMPLET du disque et
    // reste donc vrai même en lecture partielle. Sans cette exception, la branche Tests
    // répondait « impossible de conclure » sur un projet dont on SAIT qu'il n'a aucun test.
    it("le « Signal projet » reste explicitement fiable malgré la couverture partielle", async () => {
      const brain = spyBrain()
      await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), brain.ask)
      const prompt = brain.prompts[0]
      expect(prompt).toContain('EXCEPTION : un « Signal projet »')
      expect(prompt).toContain('analyse complète')
      // L'exception vient APRÈS l'interdiction : elle la restreint, elle ne l'annule pas.
      expect(prompt.indexOf('EXCEPTION')).toBeGreaterThan(prompt.indexOf("ne conclus rien d'une absence"))
    })

    it('la liste des fichiers omis est BORNÉE (15 max) — déclarer, sans noyer le prompt', async () => {
      const brain = spyBrain()
      await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), brain.ask)
      const ligne = brain.prompts[0].split('\n').find(l => l.startsWith('Fichiers NON fournis'))!
      expect(ligne).toMatch(/… \(\+\d+\)/)
      expect(ligne.split(',').length).toBeLessThanOrEqual(17)
    })

    it('couverture complète → AUCUN bloc couverture (prompt inchangé vs avant la mesure)', async () => {
      const brain = spyBrain()
      await auditWithLLM(META, ctxWith([{ path: 'a.ts', content: 'const a = 1' }]), brain.ask)
      expect(brain.prompts[0]).not.toContain('COUVERTURE DE CETTE LECTURE')
      expect(brain.prompts[0]).not.toContain('conclure')
    })

    it('fichier déjà coupé à la LECTURE (MAX_FILE_CHARS) : déclaré même si le prompt ne déborde pas', async () => {
      const brain = spyBrain()
      const files: ProjectFile[] = [{ path: 'gros.ts', content: 'x'.repeat(100), truncated: true, fullChars: 60_000 }]
      await auditWithLLM(META, ctxWith(files), brain.ask)
      expect(brain.prompts[0]).toContain('COUVERTURE DE CETTE LECTURE')
      expect(brain.prompts[0]).toContain('COUPÉS avant la fin : gros.ts')
    })
  })

  describe('2. le finding porte la couverture vers le rapport et le verdict', () => {
    it('finding.coverage renseigné, cohérent avec ce qui a été rendu', async () => {
      const brain = spyBrain()
      const f = await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), brain.ask)
      expect(f.coverage).toBeDefined()
      expect(f.coverage!.complete).toBe(false)
      expect(f.coverage!.filesTotal).toBe(40)
      expect(f.coverage!.filesRendered).toBeLessThan(40)
      expect(f.coverage!.omitted.length).toBe(40 - f.coverage!.filesRendered)
    })

    it('couverture complète → finding.coverage.complete = true', async () => {
      const brain = spyBrain()
      const f = await auditWithLLM(META, ctxWith([{ path: 'a.ts', content: 'const a = 1' }]), brain.ask)
      expect(f.coverage!.complete).toBe(true)
      expect(f.coverage!.filesRendered).toBe(1)
    })

    it('réponse LLM illisible → skip, mais la couverture reste déclarée (l\'échec ne l\'efface pas)', async () => {
      const brain = spyBrain('pas du json du tout')
      const f = await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), brain.ask)
      expect(f.status).toBe('skip')
      expect(f.coverage).toBeDefined()
      expect(f.coverage!.complete).toBe(false)
    })

    it('cerveau qui lève → skip fail-open, couverture toujours déclarée', async () => {
      const ask = async (): Promise<string> => {
        throw new Error('Ollama injoignable')
      }
      const f = await auditWithLLM(META, ctxWith(bigFiles(40, 20_000)), ask)
      expect(f.status).toBe('skip')
      expect(f.coverage).toBeDefined()
    })
  })
})

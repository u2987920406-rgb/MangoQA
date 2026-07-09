// Tests du Visage 1 — Le Disjoncteur : regression-lock (verrou régression).
// Exécution : npx tsx test-disjoncteur-regression.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { DEFAULT_BREAKER_CONFIG, cfg, FROZEN, makeEv, tripIds, makeChecker, type BreakerConfig } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-regression')
const ev = makeEv()

// ── 3. Verrou régression — #11 (constat B) : INERTE par défaut ──────────────
// Rien n'émet `payload.score` sur un event `qa.audit*` aujourd'hui (côté MangoOS,
// ChatTurnOutcome n'a que cost/turns/duration, QAVerdict n'a pas de score
// numérique) → gaté OFF par défaut (`regressionLockEnabled: false`) pour ne pas
// le compter comme actif silencieusement. On teste explicitement les deux états.
{
  const bad = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.4 } })]
  check(
    '#11 défaut (regressionLockEnabled=false) : score bas → PAS de trip (inerte)',
    !tripIds(bad).includes('regression-lock'),
  )
  check('#11 défaut : DEFAULT_BREAKER_CONFIG.regressionLockEnabled === false', DEFAULT_BREAKER_CONFIG.regressionLockEnabled === false)

  const enabledCfg: BreakerConfig = { ...cfg, regressionLockEnabled: true }
  const good = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } })]
  check('activé : score 0.9 ≥ seuil → pas de trip', !tripIds(good, enabledCfg).includes('regression-lock'))
  check('activé : score 0.4 < seuil 0.6 → trip', tripIds(bad, enabledCfg).includes('regression-lock'))

  // Le DERNIER audit compte (régression récente prime).
  const evolving = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 20 },
  ]
  check('activé : dernier audit (0.3) prime → trip', tripIds(evolving, enabledCfg).includes('regression-lock'))

  const recovered = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.8 } }), ts: 20 },
  ]
  check('activé : dernier audit (0.8) rétabli → pas de trip', !tripIds(recovered, enabledCfg).includes('regression-lock'))
}

report()

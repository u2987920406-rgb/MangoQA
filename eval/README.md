# `eval/` — Mesure de la qualité de jugement de Mango QA

> Créé le 2026-08-04, jalon **J0** de la sortie de Mango QA en produit autonome.
> Documents de cadrage : `MangoOS/docs/refonte/06-MANGOQA-PRODUIT-AUTONOME.md`.

## Pourquoi ce dossier existe

Le `README.md` de Mango QA le dit lui-même : le code actuel est une **reconstruction**
(2026-06-19) à partir du contrat d'interface, et *« les détails internes des branches
(prompts, seuils) sont une réimplémentation »*. Personne n'a jamais mesuré si les
6 branches **ont raison**.

Le seul chiffre existant vient de la sonde MangoOS du 2026-07-24 : sur 4 défauts connus
rejoués, **1 raté sur 4**, et 3 « attrapés avec réserves ». Conclusion consignée à
l'époque : *Mango QA protège solidement le CODE, pas le CONTENU.*

> **Sortir un auditeur dont on ignore le taux d'erreur serait exactement la faute qu'on
> reproche aux générateurs d'apps IA.** Ce dossier est le préalable à toute publication.

## Ce que ça mesure

| Mesure | Question posée | Pourquoi elle compte |
|---|---|---|
| **Détection** | Sur un défaut injecté et connu, la branche dit-elle `fail` ? | La valeur du produit |
| **Faux positifs** | Sur du code propre, dit-elle `fail` quand même ? | Un auditeur qui crie au loup n'est plus lu |
| **Non pertinents** | `relevant()` a-t-il seulement retenu le fichier porteur du défaut ? | Trou de **filtrage**, pas de jugement — aucun modèle ne peut le rattraper |
| **Abstentions** | A-t-elle répondu `skip` (réponse illisible, erreur) ? | Ni détection ni faute — mais jamais compté comme un succès |
| **Instabilité** | Le verdict change-t-il d'une passe à l'autre ? | Un auditeur instable est inutilisable en CI |

**La distinction « non pertinent » vs « raté » est le point central du harnais.** Un défaut
manqué parce que le filtre n'a pas retenu le fichier est un bug déterministe, corrigeable en
une ligne. Un défaut manqué alors que la branche l'a bien lu est un problème de prompt ou de
modèle. Les confondre mène à changer de modèle quand il fallait changer une regex.

## Le corpus (`corpus.ts`)

**23 cas**, tous en mémoire (`ProjectFile[]`) — aucun fichier temporaire, aucun nettoyage,
exécution reproductible.

| Famille | Cas | Contenu |
|---|---|---|
| 🔒 Sécurité | 5 | clé de service exposée · XSS `innerHTML` · injection SQL · CORS `*` · path traversal |
| ♿ Accessibilité | 4 | contraste · `img` sans `alt` · `div` cliquable · champ sans `label` |
| 🏗️ Architecture | 3 | composant monolithe · duplication triple · couplage UI↔base |
| ⚡ Performance | 3 | liste non virtualisée · `useEffect` sans deps · imports lourds |
| 🧪 Tests | 2 | logique métier non testée + **contrôle positif** (même logique, testée) |
| 🎨 Design system | 2 | couleurs hors palette · espacements arbitraires |
| ✅ **Contrôles propres** | **4** | **aucun défaut** — mesurent les faux positifs |

Les défauts choisis sont ceux que les générateurs IA produisent **réellement**, pas des cas
d'école. Chaque cas porte : le défaut, son emplacement, la règle de référence (OWASP/WCAG),
et le verdict attendu **par branche**.

### Les contrôles propres ne sont pas un supplément

Sans eux, une branche qui répondrait `fail` à tout obtiendrait **100 % de détection**. Ils
sont la moitié de la mesure.

## Usage

```bash
npx tsx eval/run-eval.ts                          # tout le corpus, 1 passe
npx tsx eval/run-eval.ts --only security          # une seule branche
npx tsx eval/run-eval.ts --case SEC-01            # un cas (préfixe accepté)
npx tsx eval/run-eval.ts --repeat 3               # 3 passes → mesure la variabilité
npx tsx eval/run-eval.ts --json rapport.json      # sortie machine en plus du tableau
```

Les rapports datés sont écrits dans `eval/rapports/`.

## Ce que le harnais ne fait PAS

- **Aucun mock.** Il appelle le vrai cerveau d'audit configuré dans `.env`. Un chiffre obtenu
  contre un mock ne veut rien dire.
- **Aucune parallélisation.** Ollama est mono-GPU et l'abonnement Claude est limité en débit :
  paralléliser fausserait les durées et déclencherait des 429.
- **Aucun rapport si le cerveau ne répond pas.** Le préflight échoue → sortie code 2, rien
  d'écrit. Un tableau plein de `skip` ressemblerait à une mesure sans en être une.

## Comment étendre le corpus

Ajouter un cas dans la famille correspondante de `corpus.ts` :

```ts
{
  id: 'SEC-06-jwt-non-verifie',
  defect: 'Le JWT est décodé sans vérification de signature.',
  location: 'server/auth.js:12',
  rule: 'OWASP A07 — Identification and Authentication Failures',
  expect: { security: 'fail' },
  files: [{ path: 'server/auth.js', content: `…` }],
}
```

**Règle** : tout défaut réellement rencontré en production entre au corpus **avant** d'être
corrigé. C'est ce qui empêche le corpus de vieillir en jeu d'école.

Et à chaque nouveau cas à défaut, se demander s'il faut aussi **un contrôle propre voisin** —
du code qui ressemble au cas fautif mais qui est correct. C'est ce qui mesure si la branche
distingue vraiment, au lieu de réagir à un mot-clé.

# Plafond de contexte — Ollama / qwen2.5-coder:14b

**Verdict (2026-08-04) : aucune troncature silencieuse jusqu'au projet entier.**
Les 20 fichiers d'`abyss` (95 004 caracteres, 95 731 une fois rendus avec les en-tetes)
passent en **un seul appel**, soit **28 930 tokens**, sans qu'il soit necessaire de forcer
`num_ctx`. L'audit 100 % en un appel est donc realisable — la couverture de 27 % du rapport
J1 venait du cap de rendu, pas d'une limite d'Ollama.

**Reserve de methode :** la colonne `num_ctx 32768` ne constitue pas une mesure independante.
Le second appel reutilise le cache KV du premier (4 s contre 140 s), la valeur y est rejouee
plutot que recalculee. La conclusion tient sur le premier appel seul, qui retourne bien le
compte complet du prompt au lieu d'un plafond tronque.

---

## Sonde plafond — 2026-08-04 23:02

Projet abyss : 20 fichiers, 95 004 caracteres (~27 144 tokens)

| cap | car. rendus | tokens attendus | defaut | num_ctx 32768 | ecart |
|---|---|---|---|---|---|
| 24 000 | 24 013 | ~6 861 | 6763 | 6763 | identique |
| 40 000 | 40 013 | ~11 432 | 11228 | 11228 | identique |
| 60 000 | 60 013 | ~17 147 | 16913 | 16913 | identique |

**Aucune troncature silencieuse jusqu'a 60 000 caracteres.**

## Sonde plafond — 2026-08-04 23:41

Projet abyss : 20 fichiers, 95 004 caracteres (~27 144 tokens)

| cap | car. rendus | couverture | tokens attendus | defaut | num_ctx 32768 | ecart |
|---|---|---|---|---|---|---|
| 95 000 | 95 013 | 19/20 (dernier tronque) | ~27 147 | 28668 | 28668 | identique |

**Aucune troncature silencieuse jusqu'a 95 000 caracteres.**
Couverture partielle : le cap coupe dans le 20ᵉ fichier, les en-tetes `----- chemin -----`
poses par `renderFiles` ajoutant ~727 caracteres au contenu brut.

## Sonde plafond — 2026-08-04 23:47

Projet abyss : 20 fichiers, 95 004 caracteres (~27 144 tokens)

| cap | car. rendus | couverture | tokens attendus | defaut | num_ctx 32768 | ecart |
|---|---|---|---|---|---|---|
| 100 000 | 95 731 | 20/20 | ~27 352 | 28930 | 28930 | identique |

**Aucune troncature silencieuse jusqu'a 100 000 caracteres.**
Couverture complete : les 20 fichiers (95 004 car.) tiennent en un seul appel.

---

## Notes de journal

Les horodatages ci-dessus sont en **heure locale**. Les sections anterieures au 2026-08-04
23:47 avaient ete ecrites en UTC par `toISOString()` (soit 2 h de retard) ; elles ont ete
converties ici, et la source corrigee.

Deux sections mortes ont ete retirees (runs de 23:07 et 23:32) : elles ne contenaient qu'un
en-tete de tableau sans aucune ligne. Cause identifiee : `UND_ERR_HEADERS_TIMEOUT`, le
`fetch` de Node abandonnant au bout de 300 s alors qu'Ollama calculait encore. Corrige en
passant par `node:http`, sans delai cote client.

**Un rapport tronque de cette maniere n'est pas une preuve de coupure machine** — c'est la
signature normale de ce timeout. La confusion a coute une soiree de diagnostic.

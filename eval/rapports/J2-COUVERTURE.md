# J2 — Couverture : l'auditeur dit ce qu'il n'a pas lu

> Ouvert le **2026-08-05**, en reprise de J1. Objet : le point **bloquant** laissé par J1 —
> *« un auditeur a le droit de ne pas tout lire ; il n'a pas le droit de le taire »*.
> Runs bruts : `J2-RUNS-abyss.md`. Cerveau : `qwen2.5-coder:14b` local, `QA_LOCAL_ONLY=on`.

---

## L'ordre, et pourquoi il n'était pas négociable

Trois travaux étaient en attente. Ils ont été faits dans cet ordre, jamais un autre :

1. **Déclarer** la couverture ;
2. **remonter** le cap de prompt (24 000 → 100 000) ;
3. **étendre** le corpus aux fichiers longs.

Faire 2 avant 1 était tentant : une ligne à changer, et la couverture d'`abyss` passait de
27 % à 100 %. Mais remonter le cap seul rend la troncature silencieuse **plus rare sans la
rendre impossible**. Au premier projet dépassant le nouveau cap, l'auditeur aurait menti
comme avant — en plus rare, donc en moins détectable. C'est le pire des deux mondes.

---

## Ce qui a été construit

| Étage | Ce qui manquait | Ce qui existe maintenant |
|---|---|---|
| `fs-shared.ts` | `renderFiles` s'arrêtait au cap et faisait `break`, sans trace | `renderFilesWithCoverage()` : fichiers omis **nommés**, fichiers coupés, caractères vus / caractères réels |
| `orchestrator.ts` | 2ᵉ étage de perte invisible : le cap `MAX_FILES` écartait des fichiers découverts | `ReadStats` (découverts / lus / écartés) et `fullChars`, la taille réelle avant coupe |
| `llm.ts` | Le modèle croyait voir tout le projet | Bloc de couverture injecté **dans le prompt** : ratio, fichiers non fournis, interdiction de conclure par absence |
| `audit.ts` | `filesScanned` seul, sans notion de vu | `AuditReport.coverage` — les trois étages |
| `verdict.ts` | Un Feu Vert partiel était indiscernable d'un Feu Vert complet | `QAVerdict.coverage` + mention recopiée en clair dans chaque résumé de branche |

### Deux décisions de conception qui portent tout le reste

**`complete: true` n'est jamais une valeur par défaut.** Une couverture non mesurée reste
`undefined`. Confondre « non mesuré » et « tout lu » serait refaire le défaut d'un cran plus
haut — c'est le seul endroit où un booléen optimiste aurait annulé le travail entier.

**Le contrat figé n'a pas bougé.** `verdict` reste `'green' | 'red'` : introduire un troisième
état aurait cassé le lecteur de MangoOS. La couverture est un champ **additif**, et la mention
est *en plus* recopiée en clair dans le texte de chaque résumé — pour qu'un affichage non mis à
jour ne puisse pas présenter un audit partiel comme un audit complet.

---

## Mesure 1 — le même projet, le même cap qu'en J1

`abyss`, 20 fichiers, cap 24 000 caractères. **Comparaison à périmètre identique avec J1.**

| | J1 (2026-08-04) | J2 (2026-08-05) |
|---|---|---|
| 🏗️ Architecture | 🟢 « 19 fichiers » | ⚪ **5/19 vus** — « le fichier fourni est tronqué » |
| 🔒 Sécurité | 🟢 4 fichiers | 🟢 **4/4 vus** |
| ⚡ Performance | 🔴 « 19 fichiers » — clé manquante | ⚪ **5/19 vus** |
| 🧪 Tests | 🔴 « 19 fichiers » | ⚪ **5/19 vus** |
| **Verdict** | 🔴 FEU ROUGE | 🟢 FEU VERT ⚠️ **SUR LECTURE PARTIELLE** |

Le rapport nomme désormais les 14 fichiers jamais envoyés, branche par branche. Et une chose
devient lisible qui ne l'était pas : **Sécurité est la seule branche à avoir vu tout son
périmètre** (4/4). C'est donc le seul verdict de ce run qui vaut quelque chose. Avant, les six
se ressemblaient.

> **Le prix de l'honnêteté, mesuré.** Quatre branches sur six s'abstiennent. Un Feu Vert où
> presque rien n'a été jugé est honnête, mais stérile. C'est l'argument chiffré du relèvement
> du cap — constaté, plus supposé.

---

## Mesure 2 — le même projet, le nouveau cap

`abyss`, cap 100 000 caractères (défaut), tout le reste identique.

```
  🟢 🏗️ Architecture    315.2s  19/19 vus   Aucune violation structurelle majeure détectée.
  🟢 🔒 Sécurité         61.5s   4/4 vus    Aucune vulnérabilité OWASP détectée.
  🟢 ♿ Accessibilité   137.2s  13/13 vus   Aucune barrière d'accès concrète détectée.
  🟢 ⚡ Performance     345.5s  19/19 vus   Aucun anti-pattern majeur détecté.
  🔴 🧪 Tests           351.0s  19/19 vus   Aucun fichier de test n'existe dans le projet.
  🟢 🎨 Design System   171.0s  14/14 vus   Cohérence respectée, palette réutilisée.

  COUVERTURE → COMPLÈTE : tout le code a été lu et vu.
  VERDICT : 🔴 FEU ROUGE — branche tests (missing-test-files)
```

**Couverture complète sur les six branches**, en un seul appel par branche, sans troncature
silencieuse — ce que la sonde plafond du 2026-08-04 laissait attendre est confirmé en usage
réel. Et le Feu Rouge sur Tests est **vrai** : `abyss` n'a aucun fichier de test, et cette fois
la branche l'affirme après avoir vu 19/19 fichiers, pas 5.

C'est la différence entre les deux mesures, et c'est tout l'objet de J2 : le verdict de la
mesure 2 porte sur le code entier, et on peut le prouver.

---

## 🔎 Le faux positif de J1 ne s'est reproduit dans aucun des deux runs

En J1, la branche Performance exigeait d'ajouter `key={c.id}` **déjà présent ligne 308** de
`Catalogue.jsx`. Aujourd'hui : ⚪ abstention au cap 24 000, 🟢 `pass` au cap 100 000.

**Je n'attribue cette disparition à rien.** Trois causes sont possibles et ce dispositif ne
permet pas de les départager :

- le bloc de couverture aurait rendu le modèle plus prudent — mais **il est absent du run 2**
  (couverture complète → chaîne vide, prompt inchangé), et le faux positif n'y est pas non plus ;
- le contexte élargi aurait suffi — mais en J1, `Catalogue.jsx` était **déjà** intégralement
  dans le prompt, vérifié à la main ;
- la simple variabilité d'un run à l'autre, à température 0.

> **Deux runs ne font pas une mesure.** C'est la famille `LONG` du corpus qui tranche, parce
> qu'elle rejoue le cas de manière répétable et appariée — pas un audit de projet réel.

---

## Ce que l'usage a corrigé dans le correctif lui-même

**Une interdiction trop large ne rend pas l'auditeur prudent, elle le rend muet.** Le premier
jet du bloc de couverture disait : *« tu ne peux RIEN conclure d'une absence »*. Au run 1, la
branche Tests a répondu « aucun fichier de test trouvé, **impossible de conclure** » — alors
qu'un « Signal projet » lui affirmait, sur la foi d'un balayage complet du disque, qu'aucun
test n'existe nulle part. L'interdiction désarmait un signal fiable.

Corrigé par une exception explicite : *un « Signal projet » porte sur TOUT le projet, celui-là
tu peux t'y fier*. Sous test (`test-llm-coverage.ts`), y compris l'ordre des deux phrases —
l'exception doit **restreindre** l'interdiction, pas l'annuler.

---

## 🕳️ Un piège dormant, réveillé par le relèvement du cap

`askOllama` passait par `fetch`. Undici coupe à **300 s** si les en-têtes ne sont pas arrivés
(`UND_ERR_HEADERS_TIMEOUT`), et avec `stream: false` Ollama ne les envoie qu'après avoir
calculé toute la réponse. Ce plafond est invisible dans le code et **insensible au `signal`**.
Il a déjà coûté une soirée de diagnostic sur la sonde plafond, où il imitait une coupure machine.

Inoffensif à 24 000 caractères. **Actif à 100 000** : la mesure 2 a demandé jusqu'à 351 s sur
une seule branche. En l'état, ces audits seraient tombés en `skip` fail-open — c'est-à-dire
**auraient disparu sans bruit**, exactement le défaut qu'on corrigeait, déplacé d'un cran.

Passé en `node:http` : le seul délai est le nôtre, explicite (`QA_OLLAMA_TIMEOUT_MS`).

> **Un cap n'est pas qu'un nombre.** Le relever a déplacé le régime de fonctionnement dans une
> zone où une contrainte jusque-là théorique devient la contrainte dominante.

### Et un mock qui visait le transport au lieu de l'intention

Les tests des 6 branches simulaient « Ollama injoignable » en piégeant `fetch`. En changeant de
transport, **18 tests sont partis pour de bon sur le réseau** — sans que rien ne le signale
autrement que par leur lenteur. Le mock vise désormais la frontière (`ollama-client`), qui ne
bouge pas quand le transport bouge.

---

## Le corpus, étendu là où il était aveugle

J0 donnait `0/45 faux positifs`. Ce score reste vrai — **il ne mesurait simplement pas ce qu'on
croyait** : la capacité à juger un défaut *isolé*, dans un fichier de 12 à 40 lignes.

`eval/corpus-long.ts` ajoute 4 cas de 150 à 240 lignes, construits sur trois règles propres :

- **appariement** — `LONG-01` ↔ `LONG-02` : le même fichier de 237 lignes, à une clé près.
  Sans le jumeau propre, on ne distingue pas « détecte » de « crie au loup dès que c'est long » ;
- **enfouissement** — le défaut est dans le dernier tiers, jamais en tête ;
- **voisinage trompeur** — le fichier propre contient délibérément des constructions qui
  ressemblent au défaut : quatre `.map()` en série, du HTML injecté mais assaini. C'est là que
  naissent les hallucinations, pas sur du code neutre.

`LONG-01` est le rejeu exact du faux positif de J1. Corpus : **27 cas** (21 à défaut, 6 propres).

### Mesure — 9 observations, 1 passe, `qwen2.5-coder:14b`, 439 s

| Branche | Détection | Ratés | Faux positifs | Durée moy. |
|---|---|---|---|---|
| security | **1/1** (100 %) | 0 | 0/2 | 39,6 s |
| performance | **1/1** (100 %) | 0 | 0/2 | 62,1 s |
| accessibility | — | 0 | 0/1 | 33,1 s |
| architecture | — | 0 | **1/2** | 50,5 s |

**Le faux positif de J1 ne se reproduit pas sur le cas apparié.** C'est le résultat que les
deux audits d'`abyss` ne pouvaient pas donner :

- `LONG-01` (4 `.map()`, 4 clés) → Performance répond `pass` : *« aucun anti-pattern majeur »* ;
- `LONG-02` (**le même fichier**, une seule clé retirée, enfouie dans le dernier tiers) →
  Performance répond `fail` : *« clé manquante dans une liste »*.

La branche **discrimine** donc sur une paire de fichiers de 210 lignes qui ne diffèrent que par
la ligne en cause. « Fichier long → hallucination » est écarté comme explication générale. Le
faux positif de J1 reste réel, mais il n'est pas systématique sur cette forme de code.

`LONG-03` confirme au passage que la **détection survit à l'enfouissement** : l'XSS placé aux
deux tiers d'un tableau de bord de 210 lignes est trouvé (`innerHTML` avec donnée non assainie).

### Le faux positif restant, et ce qu'il m'a obligé à corriger dans MON corpus

Architecture, sur `LONG-01` : *« composant monolithe avec plus de 300 lignes »*. Deux choses
s'y mêlent, qu'il fallait séparer avant de compter un point :

- **Sur le fond, elle n'a pas tort.** 210 lignes mêlant fetch, filtres, tri, pagination,
  favoris et rendu, c'est très exactement le cas `ARCH-01` du corpus principal. Écrire
  `architecture: 'pass'` était un excès **de ma part** : `LONG-01` a été construit comme un
  contrôle de *clés de liste*, pas d'architecture. Le corpus a sa propre règle — *« on ne note
  que ce qu'on est sûr d'affirmer »* — et je l'avais enfreinte. L'assertion est retirée.
- **Sur la forme, sa justification est fausse.** Le fichier fait **210 lignes**, vérifié, pas
  « plus de 300 ». C'est la même famille que le défaut n°1 de J1 : affirmer un fait que le
  texte fourni contredit. Ce n'est plus noté, mais c'est consigné ici et reste à surveiller.

> Retirer une assertion mal fondée n'est pas blanchir un score — la garder l'aurait été. Le
> contrôle « long fichier architecturalement propre » existe déjà et il passe : c'est `LONG-04`.

### Mesure finale — 7 cas, 3 passes, 33 observations, 959 s

Une passe ne mesure pas la stabilité : un faux positif intermittent serait manqué une fois sur
deux. Et la 1ʳᵉ vague de cas longs n'exerçait que 2 branches avec un vrai défaut. Trois cas ont
donc été ajoutés (`LONG-05` tests non testés · `LONG-06` **contrôle positif**, même logique
testée · `LONG-07` couplage UI↔base enfoui), puis `--repeat 3`, repli Claude coupé :

| Branche | Détection (cas) | Faux positifs (jugements réels) | **Instables** | Durée moy. |
|---|---|---|---|---|
| architecture | **1/1** aux 3 passes | 0/3 | **0** | 44,3 s |
| security | **1/1** aux 3 passes | 0/3 *(+3 hors périmètre)* | **0** | 21,7 s |
| performance | **1/1** aux 3 passes | 0/6 | **0** | 25,9 s |
| tests | **1/1** aux 3 passes | 0/3 | **0** | 33,7 s |
| accessibility | — | 0/3 | **0** | 21,1 s |

**Les quatre branches bloquantes détectent leur défaut enfoui, aux trois passes.** Le harnais
compte volontairement sévère : un cas ne compte comme détecté que si **toutes** les passes l'ont
détecté. **Zéro verdict instable, zéro faux positif sur 18 jugements propres réels** — dont les
trois passes sur `LONG-01`, le rejeu exact du cas de J1.

### Les motifs, vérifiés à la main — un verdict juste peut l'être pour la mauvaise raison

`LONG-07` était le cas à risque : un fichier long peut être rejeté pour « composant monolithe »
au lieu du couplage injecté, ce qui donnerait un point de détection imMérité. Le fichier a donc
été écrit découpé en petites fonctions nommées, sous-composants extraits, pour que la seule
violation disponible soit l'accès direct à la base. Les trois passes citent le bon motif, au
mot près :

> « Le composant de présentation TableauBordVentes ouvre une connexion directe à la base de
> données, ce qui crée un couplage fort évitable. »

Et le contrôle positif a fait son travail : `LONG-06` → *« toutes les fonctions logiques
importantes sont couvertes par des tests »*, trois fois sur trois. La branche a donc lu le
fichier de test, pas seulement compté des fichiers. **Sans ce contrôle, le 1/1 de `LONG-05`
n'aurait rien valu** : une branche répondant « fail » à tout code long aurait affiché 100 %.

### Un défaut du HARNAIS, trouvé en relisant ses propres chiffres

La colonne « faux positifs » de security affichait `0/6`. Or `LONG-01` ne contient que du
`.jsx` : `relevant()` n'y retenait rien, et la branche n'a statué que **3 fois**. Le harnais
comptait ces trois non-événements en « pass correct », c'est-à-dire **au crédit de la branche**.

C'est le défaut de J1 déplacé dans l'instrument de mesure : confondre « n'a pas regardé » avec
« a regardé et n'a rien trouvé ». Et il jouait dans le sens flatteur, ce qui est le pire.

Corrigé : catégorie `hors-perimetre` distincte, **exclue du dénominateur**, affichée à côté
(`0/3 (+3 hors périmètre)`). L'affichage en cours de run ne les étiquette plus « abstention » —
une abstention est un vrai échec de jugement, pas un non-événement.

> **Mesurer l'honnêteté avec un instrument complaisant n'a aucun sens.** Le harnais est soumis
> à la même règle que le produit qu'il note.

> Le faux positif de J1 n'est donc ni systématique ni intermittent **sur cette forme de code**.
> Il reste un fait observé une fois, sur `abyss`, que ce corpus ne reproduit pas. C'est la
> limite honnête de ce qu'on peut affirmer : le corpus dit que la branche discrimine de façon
> stable ici, pas que l'hallucination ne peut plus survenir ailleurs.

Les durées, elles, ont fondu par rapport à la 1ʳᵉ mesure (20,8 s contre 50,3 s pour la même
observation). Rien n'a changé dans le code : le modèle était chaud et **rien d'autre ne tournait
sur la machine**. C'est la confirmation qu'une durée mesurée pendant une autre charge n'est pas
une donnée — les 39 % de couches sur CPU se disputent les 4 cœurs.

### Ce que cette mesure n'établit toujours PAS

Les répétitions mesurent la **stabilité**, pas l'étendue. Derrière les 33 observations il y a
**4 jugements de défaut** et **6 jugements propres** distincts, répétés 3 fois chacun. Un seul
modèle, une seule machine, sept cas.

Et surtout : **le faux positif d'`abyss` n'est toujours pas expliqué.** Il a été observé une
fois, le 2026-08-04, et ce corpus ne le reproduit ni systématiquement ni par intermittence.
L'instrument construit pour le capturer n'a pas sonné — ce n'est pas la même chose qu'un défaut
corrigé.

---

## État des points laissés par J1

| # | Sujet | État |
|---|---|---|
| 1 | **Déclarer la couverture** | ✅ **Fait** — prompt, rapport, verdict. Vérifié sur projet réel |
| 2 | Découpage en lots vs cap assumé | ✅ **Tranché** — cap assumé à 100 000, aucun lot nécessaire |
| 3 | Fichiers longs au corpus | ✅ **Fait** — 4 cas appariés, mesurés : détection 2/2, 1 faux positif (assertion retirée) |
| 4 | Intégration MangoOS (60 s vs ~1 380 s) | 🟡 **Ouvert, hors MangoQA** — et l'écart s'est creusé |

**Le point 4 s'est aggravé et mérite d'être redit.** Le budget de clôture MangoOS est de 60 s.
Un audit complet à couverture 100 % en demande **1 381**. L'écart est passé d'un facteur 6 à un
facteur 23. En l'état, MangoOS marquerait chaque clôture « non-vérifiée » en fail-open et
l'audit disparaîtrait sans bruit — la voie non bloquante `surfaceVerdict` existe mais n'est
appelée nulle part. Sans effet sur l'usage autonome (CLI / CI / MCP), qui n'a aucun budget de
60 s ; à trancher côté MangoOS.

---

## Verdict de J2

> **Atteint.** L'audit partiel ne peut plus se taire : il est mesuré à trois étages, déclaré au
> modèle, au rapport et au verdict. Le cap est passé à 100 000 **après** cette garantie, et un
> projet réel est désormais audité à 100 % en un appel par branche.
>
> Comme en J0 et en J1, l'exercice a rapporté plus que sa case cochée : un plafond réseau
> dormant que le nouveau cap aurait transformé en pannes silencieuses, un mock qui testait le
> transport au lieu de l'intention, et un correctif dont l'usage a montré qu'il rendait
> l'auditeur muet là où il devait le rendre prudent.

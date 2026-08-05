# Runs bruts — audits de `abyss` du 2026-08-05

> Écrit par `eval/audit-projet.ts`. Analyse dans `J2-COUVERTURE.md`.

## Audit abyss — 2026-08-05 01:33

cap prompt : 24000 caractères

```
Projet : abyss  (D:\IA\MangoOS\workspace\abyss)
Cerveau : qwen2.5-coder:14b   cap prompt : 24000 car.

  ⚪ 🏗️ Architecture    111.1s  5/19 vus     ⚠️ PARTIEL  Le fichier fourni est tronqué et ne contient pas l'ensemble du code.
  🟢 🔒 Sécurité        183.1s  4/4 vus       Aucune vulnérabilité OWASP détectée dans le code fourni.
  ⚪ ♿ Accessibilité   156.3s  5/13 vus     ⚠️ PARTIEL  Aucun élément pertinent à auditer dans les fichiers fournis.
  ⚪ ⚡ Performance     167.3s  5/19 vus     ⚠️ PARTIEL  Aucun élément pertinent à auditer dans les fichiers fournis.
  ⚪ 🧪 Tests           175.1s  5/19 vus     ⚠️ PARTIEL  Aucun fichier de test trouvé, impossible de conclure.
  🟢 🎨 Design System   213.0s  5/14 vus     ⚠️ PARTIEL  La cohérence du design system semble globalement respectée avec une palette de couleurs réutilisée et des échelles d'espacement cohérentes.

  COUVERTURE
    Fichiers découverts  : 20
    Fichiers lus         : 20  (100 %)
    ⚠️ architecture : 5/19 fichiers envoyés au modèle (26 % du code) — non vus : src/components/Hero.jsx, src/components/Navigation.jsx, src/components/Quiz.jsx, src/components/ui/badge.jsx, src/components/ui/button.jsx, src/components/ui/card.jsx, src/components/ui/input.jsx, src/components/ZoneSections.jsx, src/data/abyssData.js, src/data/creatures.js, src/data/quiz.js, src/data/zones.js, src/hooks/useAbyss.js, src/lib/utils.js
    ⚠️ accessibility : 5/13 fichiers envoyés au modèle (46 % du code) — non vus : src/components/Hero.jsx, src/components/Navigation.jsx, src/components/Quiz.jsx, src/components/ui/badge.jsx, src/components/ui/button.jsx, src/components/ui/card.jsx, src/components/ui/input.jsx, src/components/ZoneSections.jsx
    ⚠️ performance : 5/19 fichiers envoyés au modèle (26 % du code) — non vus : src/components/Hero.jsx, src/components/Navigation.jsx, src/components/Quiz.jsx, src/components/ui/badge.jsx, src/components/ui/button.jsx, src/components/ui/card.jsx, src/components/ui/input.jsx, src/components/ZoneSections.jsx, src/data/abyssData.js, src/data/creatures.js, src/data/quiz.js, src/data/zones.js, src/hooks/useAbyss.js, src/lib/utils.js
    ⚠️ tests : 5/19 fichiers envoyés au modèle (26 % du code) — non vus : src/components/Hero.jsx, src/components/Navigation.jsx, src/components/Quiz.jsx, src/components/ui/badge.jsx, src/components/ui/button.jsx, src/components/ui/card.jsx, src/components/ui/input.jsx, src/components/ZoneSections.jsx, src/data/abyssData.js, src/data/creatures.js, src/data/quiz.js, src/data/zones.js, src/hooks/useAbyss.js, src/lib/utils.js
    ⚠️ design-system : 5/14 fichiers envoyés au modèle (42 % du code) — non vus : src/components/Hero.jsx, src/components/Navigation.jsx, src/components/Quiz.jsx, src/components/ui/badge.jsx, src/components/ui/button.jsx, src/components/ui/card.jsx, src/components/ui/input.jsx, src/components/ZoneSections.jsx, src/index.css
    → PARTIELLE : le verdict ci-dessous ne porte PAS sur tout le code.

  VERDICT : 🟢 FEU VERT  ⚠️ SUR LECTURE PARTIELLE
  Couverture au verdict : architecture 5/19, accessibility 5/13, performance 5/19, tests 5/19, design-system 5/14
  Durée totale : 1006.0s
```

## Audit abyss — 2026-08-05 01:57

cerveau : qwen2.5-coder:14b · cap prompt : 100000 (défaut) caractères

```
Projet : abyss  (D:\IA\MangoOS\workspace\abyss)
Cerveau : qwen2.5-coder:14b   cap prompt : 100000 (défaut) car.

  🟢 🏗️ Architecture    315.2s  19/19 vus     Aucune violation structurelle majeure détectée.
  🟢 🔒 Sécurité        61.5s  4/4 vus       Aucune vulnérabilité OWASP détectée dans le code fourni.
  🟢 ♿ Accessibilité   137.2s  13/13 vus     Aucune barrière d'accès concrète détectée.
  🟢 ⚡ Performance     345.5s  19/19 vus     Aucun anti-pattern majeur détecté dans le code fourni.
  🔴 🧪 Tests           351.0s  19/19 vus     Aucun fichier de test n'existe dans le projet.
  🟢 🎨 Design System   171.0s  14/14 vus     La cohérence du design system est respectée avec une palette de couleurs réutilisée et des valeurs d'espacement régulières.

  COUVERTURE
    Fichiers découverts  : 20
    Fichiers lus         : 20  (100 %)
    → COMPLÈTE : tout le code a été lu et vu.

  VERDICT : 🔴 FEU ROUGE — branche tests (missing-test-files)
  Correctif : « Créer des fichiers de tests pour couvrir la logique métier, notamment les hooks et les composants avec des calculs ou des validations. »
  Durée totale : 1381.4s
```

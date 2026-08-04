// Configuration de Mango QA — résolution de la racine surveillée.
//
// (2026-08-04, J1 « détacher ») Mango QA s'appelait `MANGOAI_WORKSPACE` : le nom
// disait que le produit était une pièce de MangoOS. Il devient `MANGOQA_ROOT`.
//
// Ce n'est pas que cosmétique : le mode WATCHER (surveiller un dossier qui contient
// plusieurs projets) n'a rien de spécifique à MangoOS — n'importe qui peut vouloir
// surveiller son dossier de travail. Le nom empêchait de le voir.
//
// RÉTROCOMPATIBILITÉ STRICTE : `MANGOAI_WORKSPACE` reste lu en repli, sans avertissement
// bruyant. Une installation MangoOS existante continue de fonctionner sans rien changer.

/** Racine surveillée en mode watcher. '' si aucune n'est configurée. */
export function mangoqaRoot(): string {
  const modern = (process.env.MANGOQA_ROOT ?? '').trim()
  if (modern) return modern
  return (process.env.MANGOAI_WORKSPACE ?? '').trim()
}

/** Laquelle des deux variables a effectivement servi (pour un message d'erreur exact). */
export function rootVarName(): string {
  return (process.env.MANGOQA_ROOT ?? '').trim() ? 'MANGOQA_ROOT' : 'MANGOAI_WORKSPACE'
}

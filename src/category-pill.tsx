import { cash } from '@/lib/finance';

/** A transaction's category, or "Split" with its parts on hover. */
export function CategoryPill({
  transaction: t,
}: {
  transaction: { category: string; splits?: { category: string; amount: number }[] };
}) {
  if (t.splits?.length)
    return (
      <span
        className="category-pill category-split"
        title={t.splits.map((p) => `${p.category}: ${cash(p.amount, 2)}`).join('\n')}
      >
        Split · {t.splits.length}
      </span>
    );
  return <span className={'category-pill category-' + t.category.toLowerCase()}>{t.category}</span>;
}

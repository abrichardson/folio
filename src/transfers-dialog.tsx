import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { cash, type Finance } from '@/lib/finance';
import { findTransfers, linkTransfers, looksLikeTransfer } from '@/lib/transfers';

const shortDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Suggested transfers between the user's accounts, to confirm and link. */
export function TransfersForm({
  data,
  saving,
  onSave,
}: {
  data: Finance;
  saving: boolean;
  onSave: (next: Finance, linked: number) => Promise<void>;
}) {
  const [pairs] = useState(() => findTransfers(data));
  const [picked, setPicked] = useState(
    () => new Set(pairs.filter(looksLikeTransfer).map((p) => p.out.id)),
  );
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? 'Account';
  const chosen = pairs.filter((p) => picked.has(p.out.id));
  return (
    <div className="record-form">
      {!pairs.length ? (
        <p className="form-hint">
          No unmatched transfers found. Folio looks for the same amount leaving one of your accounts
          and arriving in another within 5 days.
        </p>
      ) : (
        <>
          <p className="form-hint">
            Each pair is the same amount leaving one account and arriving in another within 5 days.
            Linked pairs are filed as Transfer, so neither side counts as spending or income. Pairs
            that already look like transfers are ticked.
          </p>
          <div className="reconcile-list transfer-list">
            {pairs.map((p) => (
              <label className="transfer-row" key={p.out.id}>
                <input
                  type="checkbox"
                  checked={picked.has(p.out.id)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.out.id)) next.delete(p.out.id);
                      else next.add(p.out.id);
                      return next;
                    })
                  }
                />
                <span>
                  <b>{cash(-p.out.amount, 2)}</b> from {name(p.out.accountId)} to{' '}
                  {name(p.in.accountId)}
                  <small>
                    {shortDate(p.out.date)} · {p.out.merchant} → {shortDate(p.in.date)} ·{' '}
                    {p.in.merchant}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="form-actions">
        <span />
        <button
          className="primary"
          disabled={saving || !chosen.length}
          onClick={() =>
            void onSave(
              linkTransfers(data, chosen, () => crypto.randomUUID()),
              chosen.length,
            )
          }
        >
          <ArrowRightLeft size={16} />
          Link {chosen.length} transfer{chosen.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

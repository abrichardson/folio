import { useEffect, useState } from 'react';
import { Download, Eye, Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Receipt } from '@/lib/finance';
import type { Storage } from './storage';

const MAX_BYTES = 15_000_000;
const size = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1e6).toFixed(1)} MB`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Receipts on a saved transaction: attach images or PDFs (stored encrypted in the data file),
 * view images, save copies, or remove them.
 */
export function ReceiptsField({
  receipts,
  storage,
  disabled,
  onChange,
}: {
  receipts: Receipt[];
  storage: Storage;
  disabled: boolean;
  /** Saves the transaction's new receipt list; resolves to false if the save failed. */
  onChange: (receipts: Receipt[]) => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  async function attach(file: File) {
    if (file.size > MAX_BYTES) return toast.error('Attach a file up to 15 MB.');
    if (receipts.length >= 10) return toast.error('A transaction can have up to 10 receipts.');
    setWorking(true);
    const id = crypto.randomUUID();
    try {
      await storage.attachments.add(id, new Uint8Array(await file.arrayBuffer()));
      const saved = await onChange([
        ...receipts,
        { id, name: file.name.slice(0, 200), type: file.type.slice(0, 100), bytes: file.size },
      ]);
      // Don't leave an orphaned file behind if the workspace could not be saved.
      if (!saved) await storage.attachments.remove([id]);
    } catch (e) {
      toast.error(message(e, 'The file could not be attached.'));
    } finally {
      setWorking(false);
    }
  }

  async function view(r: Receipt) {
    if (preview?.id === r.id) return setPreview(null);
    try {
      const bytes = await storage.attachments.get(r.id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: r.type }));
      setPreview({ id: r.id, url });
    } catch (e) {
      toast.error(message(e, 'The receipt could not be opened.'));
    }
  }

  return (
    <div className="receipts">
      <div className="receipts-head">
        <span>Receipts</span>
        <label className={'text-button file-label' + (disabled || working ? ' disabled' : '')}>
          <Paperclip size={14} /> {working ? 'Attaching…' : 'Attach a receipt'}
          <input
            type="file"
            accept="image/*,application/pdf"
            disabled={disabled || working}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void attach(f);
            }}
          />
        </label>
      </div>
      {!receipts.length && (
        <p className="form-hint">Photos or PDFs, stored encrypted with your finances.</p>
      )}
      {receipts.map((r) => (
        <div key={r.id}>
          <div className="receipt-row">
            <span className="receipt-name">{r.name || 'Receipt'}</span>
            <span className="soft">{size(r.bytes)}</span>
            {r.type.startsWith('image/') && (
              <button
                type="button"
                className="icon-button"
                aria-label={`View ${r.name}`}
                onClick={() => void view(r)}
              >
                <Eye size={15} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`Save a copy of ${r.name}`}
              onClick={() =>
                storage.attachments.saveCopy(r.id, r.name).then(
                  (saved) => saved && toast.success('Copy saved'),
                  (e) => toast.error(message(e, 'The copy could not be saved.')),
                )
              }
            >
              <Download size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${r.name}`}
              disabled={disabled || working}
              onClick={() => void onChange(receipts.filter((x) => x.id !== r.id))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {preview?.id === r.id && (
            <img className="receipt-preview" src={preview.url} alt={`Receipt ${r.name}`} />
          )}
        </div>
      ))}
    </div>
  );
}

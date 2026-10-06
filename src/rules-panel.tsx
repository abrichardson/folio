import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { allCategories, categories, type Finance } from '@/lib/finance';
import { applyRule, removeCategory, renameCategory, ruleMatches } from '@/lib/rules';

type Save = (next: Finance, message?: string) => Promise<boolean>;
const UNCHANGED = '__unchanged__';

const nameProblem = (data: Finance, name: string, except?: string) => {
  const clean = name.trim();
  if (!clean) return 'Enter a name.';
  if (clean.length > 40) return 'Use 40 characters or fewer.';
  const taken = allCategories(data).some(
    (c) => c !== except && c.toLowerCase() === clean.toLowerCase(),
  );
  return taken ? 'That category already exists.' : '';
};

/** The user's own categories: add, rename everywhere, or remove (entries move to Other). */
export function CategoriesPanel({
  data,
  saving,
  save,
}: {
  data: Finance;
  saving: boolean;
  save: Save;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const used = (c: string) => data.transactions.filter((t) => t.category === c).length;

  async function add(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(data, name);
    if (problem) return setError(problem);
    if (
      await save(
        { ...data, customCategories: [...data.customCategories, name.trim()] },
        'Category added',
      )
    ) {
      setName('');
      setError('');
    }
  }

  return (
    <section className="panel settings-panel extra-settings">
      <h2>Categories</h2>
      <p className="form-hint">
        Built in: {categories.join(', ')}. Income and Transfer are never counted as spending. A
        refund or reimbursement filed under a spending category lowers that category&apos;s
        spending.
      </p>
      <form className="inline-form" onSubmit={add}>
        <label className="form-field">
          New category
          <input
            value={name}
            maxLength={40}
            placeholder="e.g. Pets, Business supplies"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="secondary" type="submit" disabled={saving}>
          <Plus size={16} /> Add
        </button>
      </form>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      {data.customCategories.map((c) => (
        <div className="setting-row compact-row" key={c}>
          {editing?.from === c ? (
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const problem = nameProblem(data, editing.to, c);
                if (problem) return setError(problem);
                if (await save(renameCategory(data, c, editing.to.trim()), 'Category renamed')) {
                  setEditing(null);
                  setError('');
                }
              }}
            >
              <input
                aria-label={`New name for ${c}`}
                value={editing.to}
                maxLength={40}
                onChange={(e) => setEditing({ from: c, to: e.target.value })}
                autoFocus
              />
              <button className="secondary" type="submit" disabled={saving}>
                Save
              </button>
              <button type="button" className="text-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <div>
                <h3>{c}</h3>
                <p>
                  {used(c)} transaction{used(c) === 1 ? '' : 's'}
                  {data.incomeCategories.includes(c) ? ' · income' : ''}
                </p>
                <label className="check-row compact-check">
                  <input
                    type="checkbox"
                    checked={data.incomeCategories.includes(c)}
                    disabled={saving}
                    onChange={(e) =>
                      void save(
                        {
                          ...data,
                          incomeCategories: e.target.checked
                            ? [...data.incomeCategories, c]
                            : data.incomeCategories.filter((x) => x !== c),
                        },
                        e.target.checked ? `${c} counts as income` : `${c} counts as spending`,
                      )
                    }
                  />
                  <span>Money coming in (like Income), not spending</span>
                </label>
              </div>
              {removing === c ? (
                <div className="row-actions">
                  <span className="form-hint">
                    Its transactions move to Other; its budget is removed.
                  </span>
                  <button
                    className="secondary danger"
                    disabled={saving}
                    onClick={async () => {
                      if (await save(removeCategory(data, c), 'Category removed'))
                        setRemoving(null);
                    }}
                  >
                    Remove
                  </button>
                  <button className="text-button" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </div>
              ) : (
                <div className="row-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setError('');
                      setEditing({ from: c, to: c });
                    }}
                  >
                    Rename
                  </button>
                  <button className="text-button" onClick={() => setRemoving(c)}>
                    Remove
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

/** Rules that rename payees and set categories on import, first match wins. */
export function RulesPanel({ data, saving, save }: { data: Finance; saving: boolean; save: Save }) {
  const [contains, setContains] = useState('');
  const [rename, setRename] = useState('');
  const [category, setCategory] = useState(UNCHANGED);
  const [error, setError] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!contains.trim()) return setError('Enter text the description contains.');
    if (!rename.trim() && category === UNCHANGED)
      return setError('Choose a new name, a category, or both.');
    const rule = {
      id: crypto.randomUUID(),
      contains: contains.trim().slice(0, 100),
      ...(rename.trim() ? { rename: rename.trim().slice(0, 100) } : {}),
      ...(category !== UNCHANGED ? { category } : {}),
    };
    if (await save({ ...data, rules: [...data.rules, rule] }, 'Rule added')) {
      setContains('');
      setRename('');
      setCategory(UNCHANGED);
      setError('');
    }
  }

  const move = (index: number, by: number) => {
    const rules = [...data.rules];
    const [rule] = rules.splice(index, 1);
    rules.splice(index + by, 0, rule);
    void save({ ...data, rules }, 'Rule order saved');
  };

  return (
    <section className="panel settings-panel extra-settings">
      <h2>Rules</h2>
      <p className="form-hint">
        Imported transactions are renamed and categorized by the first rule that matches their bank
        description. Without a rule, Folio uses the category you last chose by hand for the same
        payee. You can also create a rule from any transaction with “Remember for this payee”.
      </p>
      <form className="rule-form" onSubmit={add}>
        <label className="form-field">
          Description contains
          <input
            value={contains}
            maxLength={100}
            placeholder="e.g. WHOLEFDS"
            onChange={(e) => setContains(e.target.value)}
          />
        </label>
        <label className="form-field">
          Show as (optional)
          <input
            value={rename}
            maxLength={100}
            placeholder="e.g. Whole Foods"
            onChange={(e) => setRename(e.target.value)}
          />
        </label>
        <label className="form-field">
          Category
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Rule category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCHANGED}>Leave as suggested</SelectItem>
              {allCategories(data).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <button className="secondary" type="submit" disabled={saving}>
          <Plus size={16} /> Add rule
        </button>
      </form>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      {data.rules.map((r, i) => {
        const matches = ruleMatches(data, r).length;
        return (
          <div className="setting-row compact-row" key={r.id}>
            <div>
              <h3>Contains “{r.contains}”</h3>
              <p>
                {[r.rename && `show as ${r.rename}`, r.category && `file under ${r.category}`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="row-actions">
              {matches > 0 && (
                <button
                  className="secondary"
                  disabled={saving}
                  onClick={() => {
                    const { next, changed } = applyRule(data, r);
                    void save(next, `${changed} transaction${changed === 1 ? '' : 's'} updated`);
                  }}
                >
                  Apply to {matches} existing
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Move rule up"
                disabled={saving || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Move rule down"
                disabled={saving || i === data.rules.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete rule for ${r.contains}`}
                disabled={saving}
                onClick={() =>
                  void save(
                    { ...data, rules: data.rules.filter((x) => x.id !== r.id) },
                    'Rule deleted',
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

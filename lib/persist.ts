// Saving sends only what changed. The data file keeps each transaction as its own row, so
// a save carries the workspace without its transactions plus the transactions that were
// added, edited, or removed since the last successful save.

export type SavedRows = Map<string, string>;

export type WorkspaceChanges = {
  /** The workspace document. Includes every transaction when `saved` was unknown. */
  payload: string;
  upsert: string[];
  remove: string[];
  /** What the file holds once this save succeeds. */
  saved: SavedRows;
};

type Workspace = { transactions: { id: string }[] };

export const savedRows = (state: Workspace): SavedRows =>
  new Map(state.transactions.map((t) => [t.id, JSON.stringify(t)]));

/**
 * Works out what to send. With no `saved` rows (nothing loaded yet), the whole workspace is
 * sent and replaces the stored transactions.
 */
export function workspaceChanges(state: Workspace, saved: SavedRows | null): WorkspaceChanges {
  const next = savedRows(state);
  if (!saved) return { payload: JSON.stringify(state), upsert: [], remove: [], saved: next };
  const rest: Record<string, unknown> = { ...state };
  delete rest.transactions;
  const upsert: string[] = [];
  for (const [id, row] of next) if (saved.get(id) !== row) upsert.push(row);
  const remove = [...saved.keys()].filter((id) => !next.has(id));
  return { payload: JSON.stringify(rest), upsert, remove, saved: next };
}

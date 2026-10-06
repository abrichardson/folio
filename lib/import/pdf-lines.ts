// pdf.js returns text as positioned fragments. Statement parsing works on lines, so
// fragments on the same baseline are joined left to right. A wide gap is written as " | "
// so text from separate columns stays visibly separate.

export type TextFragment = { str: string; x: number; y: number; width: number };

const SAME_LINE = 2.5; // points
const COLUMN_GAP = 40; // points

export function linesFromFragments(fragments: TextFragment[]): string[] {
  const rows: { y: number; items: TextFragment[] }[] = [];
  for (const f of fragments) {
    if (!f.str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.y - f.y) <= SAME_LINE);
    if (row) row.items.push(f);
    else rows.push({ y: f.y, items: [f] });
  }
  // PDF coordinates grow upward, so higher y comes first on the page.
  rows.sort((a, b) => b.y - a.y);
  return rows.map(({ items }) => {
    items.sort((a, b) => a.x - b.x);
    let line = '';
    let end = -Infinity;
    for (const item of items) {
      const gap = item.x - end;
      if (line) line += gap > COLUMN_GAP ? ' | ' : gap > 0.5 ? ' ' : '';
      line += item.str.replace(/\s+/g, ' ');
      end = item.x + item.width;
    }
    return line.replace(/ {2,}/g, ' ').trim();
  });
}

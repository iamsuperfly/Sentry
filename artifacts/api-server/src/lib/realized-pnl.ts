/** Pure realized PnL aggregation helpers. */

export function sumRealizedPnlValues(
  rows: Array<{ pnl: number | null | undefined }>,
): number {
  let sum = 0;
  for (const row of rows) {
    if (row.pnl === null || row.pnl === undefined) continue;
    const n = Number(row.pnl);
    if (!Number.isFinite(n)) continue;
    sum += n;
  }
  return Math.round(sum * 1e6) / 1e6;
}

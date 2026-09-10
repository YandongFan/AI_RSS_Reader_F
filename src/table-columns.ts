import type { TableColumnKey, TableColumnWidths } from './types';

export const TABLE_COLUMN_MIN_WIDTH = 48;

export function resizeTableColumns(
  widths: TableColumnWidths,
  key: TableColumnKey,
  nextKey: TableColumnKey | undefined,
  delta: number,
  minimum = TABLE_COLUMN_MIN_WIDTH,
): TableColumnWidths {
  const next = { ...widths };
  const currentStart = widths[key];
  if (!nextKey) {
    next[key] = Math.max(minimum, currentStart + delta);
    return next;
  }
  const nextStart = widths[nextKey];
  const nextWidth = Math.max(minimum, nextStart - delta);
  next[key] = Math.max(minimum, currentStart + (nextStart - nextWidth));
  next[nextKey] = nextWidth;
  return next;
}

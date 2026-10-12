/** Percentage of `total`, to one decimal place; 0 when nothing was sent. */
export function percentOf(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
}

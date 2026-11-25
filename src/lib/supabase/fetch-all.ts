/**
 * Read every row of a query, 1000 at a time.
 *
 * The Supabase API returns at most 1000 rows per request — `.limit(5000)`
 * silently stops at 1000 — so lists, totals and exports that need all rows
 * page through with `.range()`. Pass a function that builds the query for
 * one page (order it by a unique column so pages don't overlap):
 *
 *   const rows = await fetchAll((from, to) =>
 *     db.from('payment_records').select('contact_id, amount').eq('account_id', id).order('id').range(from, to))
 *
 * `max` is a safety stop (default 100 000 rows).
 */
export const PAGE_ROWS = 1000;

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  max = 100_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_ROWS) break;
  }
  return out;
}

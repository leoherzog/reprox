/**
 * Concurrency-limited Promise execution: bounds how many async operations are in flight at once.
 */

const DEFAULT_CONCURRENCY = 30;

/**
 * Execute async functions with limited concurrency using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Maximum concurrent operations (default: 30)
 * @returns Array of results in input order
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  // Start up to `concurrency` workers
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);
  return results;
}

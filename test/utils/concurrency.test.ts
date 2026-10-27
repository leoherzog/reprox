import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency } from '../../src/utils/concurrency';

// ============================================================================
// mapWithConcurrency Tests
// ============================================================================

describe('mapWithConcurrency', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('preserves order of results', async () => {
    const items = [1, 2, 3, 4, 5];
    // Add variable delays to simulate different execution times
    const results = await mapWithConcurrency(items, async (n) => {
      await new Promise(r => setTimeout(r, (6 - n) * 5)); // Longer delay for smaller numbers
      return n;
    });
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty array', async () => {
    const results = await mapWithConcurrency([], async (n: number) => n * 2);
    expect(results).toEqual([]);
  });

  it('handles single item', async () => {
    const results = await mapWithConcurrency([42], async (n) => n * 2);
    expect(results).toEqual([84]);
  });

  it('limits concurrency', async () => {
    const concurrency = 2;
    let activeCount = 0;
    let maxActive = 0;

    const items = [1, 2, 3, 4, 5];
    await mapWithConcurrency(
      items,
      async (n) => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(r => setTimeout(r, 10));
        activeCount--;
        return n;
      },
      concurrency
    );

    expect(maxActive).toBeLessThanOrEqual(concurrency);
  });

  it('uses default concurrency of 30', async () => {
    // Create enough items to potentially exceed concurrency
    const items = Array.from({ length: 50 }, (_, i) => i);
    let activeCount = 0;
    let maxActive = 0;

    await mapWithConcurrency(items, async (n) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise(r => setTimeout(r, 5));
      activeCount--;
      return n;
    });

    expect(maxActive).toBeLessThanOrEqual(30);
  });

  it('passes index to callback', async () => {
    const items = ['a', 'b', 'c'];
    const indices: number[] = [];
    await mapWithConcurrency(items, async (_, index) => {
      indices.push(index);
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  it('propagates errors', async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, async (n) => {
        if (n === 2) throw new Error('Test error');
        return n;
      })
    ).rejects.toThrow('Test error');
  });

  it('works with async operations', async () => {
    const items = [1, 2, 3];
    const fetchFn = vi.fn().mockImplementation(async (n) => ({ value: n * 10 }));

    const results = await mapWithConcurrency(items, fetchFn);

    expect(results).toEqual([{ value: 10 }, { value: 20 }, { value: 30 }]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

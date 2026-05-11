/**
 * Lightweight fuzzy matcher for inline filtering.
 *
 * Goals:
 * - Match characters of `query` in order (not necessarily consecutive) inside
 *   `target` — same behaviour familiar from VSCode's quick-open or fzf.
 * - Score higher when matches are consecutive or near the start.
 * - Case-insensitive.
 * - Pure + synchronous — no allocations beyond the result.
 *
 * Non-goals: full fzf parity, Sublime-style heuristics, diacritic folding.
 * If the score function ever needs tuning the entire surface is two small
 * functions; replacing is one diff.
 *
 * Returns `null` when there is no match. Returns a positive score otherwise;
 * higher = better.
 */

export interface FuzzyMatch {
  /** Higher = better. */
  score: number;
  /** Indexes of target characters that matched, in order. Empty array when query is empty. */
  matchIndexes: readonly number[];
}

/**
 * Score breakdown — kept as documented constants so tuning is obvious.
 */
const SCORE_MATCH = 16;
const SCORE_CONSECUTIVE_BONUS = 12;
const SCORE_FIRST_CHAR_BONUS = 8;
const SCORE_GAP_PENALTY = 1;

/**
 * Run a fuzzy match of `query` against `target`.
 *
 * Empty `query` is treated as "match everything" with score 1 (so callers can
 * sort by score without filtering them out).
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) {
    return { score: 1, matchIndexes: [] };
  }
  if (!target) {
    return null;
  }

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  const matchIndexes: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    let charScore = SCORE_MATCH;
    if (ti === 0) charScore += SCORE_FIRST_CHAR_BONUS;
    if (ti === lastMatchIdx + 1) charScore += SCORE_CONSECUTIVE_BONUS;

    // Subtract a small penalty per skipped character — so "abc" prefers
    // hitting "abcdef" over "axxxxxxxxbc".
    if (lastMatchIdx >= 0 && ti > lastMatchIdx + 1) {
      const gap = ti - lastMatchIdx - 1;
      charScore -= gap * SCORE_GAP_PENALTY;
    }

    score += charScore;
    matchIndexes.push(ti);
    lastMatchIdx = ti;
    qi++;
  }

  // Did we consume every query character?
  if (qi < q.length) {
    return null;
  }

  return { score, matchIndexes };
}

/**
 * Filter and sort an array of items by their fuzzy match against `query`.
 *
 * - When `query` is empty the input is returned unchanged (no sort).
 * - When `query` is non-empty, items whose `getText` does not fuzzy-match
 *   are dropped; the rest are sorted by descending score.
 *
 * `getText` lets callers fuzzy-match against arbitrary fields (a bucket name,
 * an object key, the *basename* of an object key, etc.) without committing
 * this helper to any one shape.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query) return [...items];

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const m = fuzzyMatch(query, getText(item));
    if (m) scored.push({ item, score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

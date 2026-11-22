function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = Math.min(
        (dp[j] as number) + 1,
        (dp[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

/** Closest candidate within a small edit distance, or undefined. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = distance(input.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

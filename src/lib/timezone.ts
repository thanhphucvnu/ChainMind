export type TimezoneCandidate = {
  offsetHours: number; // e.g. +7
  label: string; // e.g. "UTC+7"
  score: number; // arbitrary units
  percent: number; // 0..100 among candidates
};

export function hourHistogramToTimezoneCandidates(
  utcHourHistogram: number[],
  opts?: {
    minOffset?: number;
    maxOffset?: number;
    // "Active hours" window assumed for a human in their local time.
    // Default: 08:00..23:00 inclusive.
    activeStartHourLocal?: number;
    activeEndHourLocal?: number;
    topK?: number;
    // If histogram is all zeros (e.g. missing timestamps) but we still want an answer,
    // use a prior distribution over UTC offsets instead of returning [].
    fallbackPrior?: boolean;
  }
): TimezoneCandidate[] {
  const hist = Array.isArray(utcHourHistogram) ? utcHourHistogram.slice(0, 24) : [];
  while (hist.length < 24) hist.push(0);

  const minOffset = opts?.minOffset ?? -12;
  const maxOffset = opts?.maxOffset ?? 14;
  const activeStart = opts?.activeStartHourLocal ?? 8;
  const activeEnd = opts?.activeEndHourLocal ?? 23;
  const topK = opts?.topK ?? 5;

  const candidates: Array<{ offsetHours: number; score: number }> = [];

  const total = hist.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!total) {
    if (!opts?.fallbackPrior) return [];

    // Prior: activity likelihood decreases as offset moves away from UTC.
    const priorOffsetScores: Array<{ offsetHours: number; score: number }> = [];
    for (let offset = minOffset; offset <= maxOffset; offset += 1) {
      const score = Math.exp(-Math.abs(offset) / 6);
      priorOffsetScores.push({ offsetHours: offset, score });
    }

    priorOffsetScores.sort((a, b) => b.score - a.score);
    const top = priorOffsetScores.slice(0, topK);
    const sum = top.reduce((acc, c) => acc + c.score, 0) || 1;
    return top.map((c) => {
      const offset = c.offsetHours;
      const sign = offset >= 0 ? "+" : "";
      return {
        offsetHours: offset,
        label: `UTC${sign}${offset}`,
        score: c.score,
        percent: (c.score / sum) * 100,
      };
    });
  }

  for (let offset = minOffset; offset <= maxOffset; offset += 1) {
    // Score: fraction of activity that falls into [activeStart..activeEnd] local time.
    // Convert each UTC hour -> local hour by adding offset.
    let inWindow = 0;
    for (let utcHour = 0; utcHour < 24; utcHour += 1) {
      const localHour = (utcHour + offset + 24 * 10) % 24;
      const count = hist[utcHour] ?? 0;
      if (localHour >= activeStart && localHour <= activeEnd) inWindow += count;
    }

    // Add a mild penalty for very flat distributions to avoid over-confident results.
    const frac = inWindow / total; // 0..1
    const score = frac;
    candidates.push({ offsetHours: offset, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, topK);
  const sum = top.reduce((acc, c) => acc + c.score, 0) || 1;

  return top.map((c) => {
    const offset = c.offsetHours;
    const sign = offset >= 0 ? "+" : "";
    return {
      offsetHours: offset,
      label: `UTC${sign}${offset}`,
      score: c.score,
      percent: (c.score / sum) * 100,
    };
  });
}


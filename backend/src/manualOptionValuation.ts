import type { Transaction } from './parsers.js';

type PricePoint = {
  date: string;
  price: number;
};

function toUtcDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(start: Date, end: Date): number {
  const millis = end.getTime() - start.getTime();
  return Math.floor(millis / 86_400_000);
}

function clampDate(target: Date, min: Date, max: Date): Date {
  if (target < min) return min;
  if (target > max) return max;
  return target;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function buildManualLinearOptionSeries(
  transactions: Transaction[],
  rangeStartDate: string,
  rangeEndDate: string,
) {
  const series: Record<string, PricePoint[]> = {};
  const optionMultipliers = new Map<string, number>();

  const rangeStart = toUtcDate(rangeStartDate);
  const rangeEnd = toUtcDate(rangeEndDate);
  if (!rangeStart || !rangeEnd || rangeEnd < rangeStart) {
    return { series, optionMultipliers };
  }

  const manualOptionTransactions = transactions.filter(
    (tx) => tx.instrumentType === 'OPTION' && tx.symbol,
  );

  for (const tx of manualOptionTransactions) {
    const symbol = tx.symbol as string;
    const multiplier = Number(tx.contractMultiplier ?? 100);
    if (Number.isFinite(multiplier) && multiplier > 0) {
      optionMultipliers.set(symbol, multiplier);
    }

    if (tx.valuationMethod !== 'LINEAR') {
      continue;
    }

    const startDate = tx.valuationStartDate ? toUtcDate(tx.valuationStartDate) : null;
    const endDate = tx.valuationEndDate ? toUtcDate(tx.valuationEndDate) : null;
    const startPrice = Number(tx.valuationStartPrice);
    const endPrice = Number(tx.valuationEndPrice);

    if (!startDate || !endDate || endDate < startDate) {
      continue;
    }
    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice)) {
      continue;
    }

    const clippedStart = clampDate(startDate, rangeStart, rangeEnd);
    const clippedEnd = clampDate(endDate, rangeStart, rangeEnd);
    if (clippedEnd < clippedStart) {
      continue;
    }

    const totalSpan = Math.max(daysBetween(startDate, endDate), 1);
    const points: PricePoint[] = [];
    const clippedSpan = daysBetween(clippedStart, clippedEnd);
    for (let dayOffset = 0; dayOffset <= clippedSpan; dayOffset += 1) {
      const currentDate = addDays(clippedStart, dayOffset);
      const progress = daysBetween(startDate, currentDate) / totalSpan;
      const interpolatedPerShare = startPrice + (endPrice - startPrice) * progress;
      points.push({
        date: toIso(currentDate),
        price: interpolatedPerShare * multiplier,
      });
    }

    if (points.length === 0) {
      continue;
    }

    const existing = series[symbol] ?? [];
    const merged = [...existing, ...points]
      .sort((a, b) => a.date.localeCompare(b.date))
      .reduce((acc, point) => {
        if (acc.length > 0 && acc[acc.length - 1].date === point.date) {
          acc[acc.length - 1] = point;
          return acc;
        }
        acc.push(point);
        return acc;
      }, [] as PricePoint[]);

    series[symbol] = merged;
  }

  return { series, optionMultipliers };
}
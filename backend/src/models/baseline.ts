export type Baseline = {
  id: string;
  date: string; // ISO format: YYYY-MM-DD
  holdings: Record<string, number>; // symbol → share count
  cash: number; // total cash balance (SGD)
  source?: string; // optional (e.g. filename)
};

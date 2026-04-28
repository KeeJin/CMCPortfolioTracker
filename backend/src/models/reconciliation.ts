export type ReconciliationDiff = {
  symbol: string;
  expected: number;
  actual: number;
  difference: number;
};

export type ReconciliationResult = {
  baselineDate: string; // ISO format: YYYY-MM-DD
  status: "MATCH" | "MINOR_MISMATCH" | "MAJOR_MISMATCH";
  holdingDiffs: ReconciliationDiff[];
  cashDiff: number; // (SGD)
  notes?: string[];
};

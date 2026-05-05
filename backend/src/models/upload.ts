export type Upload = {
  id: string;
  type: "BASELINE" | "TRANSACTIONS";
  filename: string;
  uploadedAt: string; // ISO datetime
  dateRange?: {
    start: string; // ISO format: YYYY-MM-DD
    end: string; // ISO format: YYYY-MM-DD
  };
  metadata?: {
    baselineDate?: string;
    transactionCount?: number;
    duplicatesIgnored?: number;
    parseErrors?: number;
    reconciliationStatus?: "MATCH" | "MINOR_MISMATCH" | "MAJOR_MISMATCH";
  };
};

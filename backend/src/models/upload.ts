export type Upload = {
  id: string;
  type: "BASELINE" | "TRANSACTIONS";
  filename: string;
  uploadedAt: string; // ISO datetime
  dateRange?: {
    start: string; // ISO format: YYYY-MM-DD
    end: string; // ISO format: YYYY-MM-DD
  };
};

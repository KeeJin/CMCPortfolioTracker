export type TransactionType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "DEPOSIT"
  | "WITHDRAWAL";

export type Transaction = {
  id: string; // unique transaction reference (from broker)
  date: string; // ISO format: YYYY-MM-DD
  type: TransactionType;
  symbol?: string; // required for BUY/SELL/DIVIDEND
  quantity?: number; // required for BUY/SELL
  price?: number; // per-share price (SGD, if available)
  amount: number; // total cash impact (SGD)
  rawDescription?: string; // original text from statement
  source?: string; // filename or upload batch
};

export type NormalizedTransaction = {
  id: string;
  date: string; // ISO format: YYYY-MM-DD
  type: TransactionType;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number; // total cash impact (SGD)
  source: string;
};

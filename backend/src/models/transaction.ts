export type TransactionType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "SPLIT";

/**
 * Transaction represents a single financial event from a CMC Invest trading statement.
 * 
 * CURRENCY SEMANTICS:
 * - `amount`: SGD (from debit/credit columns in CMC statement)
 * - `price`: parsed as-is from statement (typically SGD for CMC quotes; may be SGD or USD)
 * 
 * POST-PARSING CONVERSION:
 * - DEPOSIT/WITHDRAWAL `amount` is converted SGD → USD before TWR/IRR calculations
 *   using USDSGD=X historical FX rates from Yahoo Finance
 * - BUY/SELL/DIVIDEND `amount` is not used for performance calculations;
 *   `price` is used only for transaction-forward-fill pricing mode
 */
export type Transaction = {
  id: string; // unique transaction reference (from broker)
  date: string; // ISO format: YYYY-MM-DD
  type: TransactionType;
  symbol?: string; // required for BUY/SELL/DIVIDEND/SPLIT
  quantity?: number; // required for BUY/SELL
  price?: number; // per-share price (SGD, as quoted in CMC statement)
  amount: number; // total cash impact (SGD from CMC debit/credit), 0 for SPLIT
  splitRatio?: number; // for SPLIT: new shares / old shares (e.g., 20 for 20:1 split)
  rawDescription?: string; // original text from statement
  source?: string; // filename or upload batch
};

/**
 * NormalizedTransaction is the canonical form after parsing.
 * All optional fields are explicitly set to null if not applicable.
 */
export type NormalizedTransaction = {
  id: string;
  date: string; // ISO format: YYYY-MM-DD
  type: TransactionType;
  symbol: string | null;
  quantity: number | null;
  price: number | null; // SGD, if available
  amount: number; // SGD from CMC debit/credit; 0 for SPLIT
  splitRatio: number | null; // for SPLIT: new shares / old shares (e.g., 20 for 20:1)
  source: string;
};

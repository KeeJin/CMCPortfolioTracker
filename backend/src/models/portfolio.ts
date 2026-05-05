export type PortfolioState = {
  date: string; // ISO format: YYYY-MM-DD
  holdings: Record<string, number>; // symbol → share count
  cash: number; // total cash balance (SGD)
};

export type PortfolioValuePoint = {
  date: string; // ISO format: YYYY-MM-DD
  totalValue: number; // holdings + cash portfolio value (USD)
  holdingsValue: number; // equity holdings value (USD)
  cashValue: number; // cash balance converted to USD
};

import type {
  Baseline,
  NormalizedTransaction,
  ReconciliationDiff,
  ReconciliationResult,
} from "./models/index.js";
import { reconstructState } from "./reconstruction.js";

const MINOR_SHARE_DIFF = 1;
const MINOR_CASH_DIFF = 1.0;

// Reconcile a new baseline against reconstructed expected state.
// expected_state = baselineA + transactions where baselineA.date < tx.date <= baselineB.date
export function reconcileBaseline(
  baselineA: Baseline,
  baselineB: Baseline,
  transactions: NormalizedTransaction[]
): ReconciliationResult {
  const relevantTransactions: NormalizedTransaction[] = [];

  for (const tx of transactions) {
    if (tx.date > baselineA.date && tx.date <= baselineB.date) {
      relevantTransactions.push(tx);
    }
  }

  const expectedState = reconstructState(baselineA, relevantTransactions);

  const symbols = new Set<string>();

  for (const symbol of Object.keys(expectedState.holdings)) {
    symbols.add(symbol);
  }

  for (const symbol of Object.keys(baselineB.holdings)) {
    symbols.add(symbol);
  }

  const holdingDiffs: ReconciliationDiff[] = [];

  for (const symbol of symbols) {
    const expected = expectedState.holdings[symbol] ?? 0;
    const actual = baselineB.holdings[symbol] ?? 0;
    const difference = actual - expected;

    if (difference !== 0) {
      holdingDiffs.push({
        symbol,
        expected,
        actual,
        difference,
      });
    }
  }

  const cashDiff = baselineB.cash - expectedState.cash;

  const isMatch = holdingDiffs.length === 0 && Math.abs(cashDiff) === 0;

  if (isMatch) {
    return {
      baselineDate: baselineB.date,
      status: "MATCH",
      holdingDiffs,
      cashDiff,
    };
  }

  let allHoldingDiffsMinor = true;

  for (const diff of holdingDiffs) {
    if (Math.abs(diff.difference) > MINOR_SHARE_DIFF) {
      allHoldingDiffsMinor = false;
      break;
    }
  }

  const isMinor = allHoldingDiffsMinor && Math.abs(cashDiff) <= MINOR_CASH_DIFF;

  if (isMinor) {
    return {
      baselineDate: baselineB.date,
      status: "MINOR_MISMATCH",
      holdingDiffs,
      cashDiff,
      notes: [
        "Minor discrepancy detected. Likely due to rounding or missing small transactions.",
      ],
    };
  }

  return {
    baselineDate: baselineB.date,
    status: "MAJOR_MISMATCH",
    holdingDiffs,
    cashDiff,
  };
}

export type TransactionType =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'SPLIT';

export type Transaction = {
  id: string;
  date: string;
  type: TransactionType;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number;
  splitRatio: number | null;
  rawDescription?: string;
  source: string;
  instrumentType?: 'EQUITY' | 'OPTION';
  underlyingSymbol?: string | null;
  optionType?: 'CALL' | 'PUT';
  strikePrice?: number | null;
  expiryDate?: string | null;
  contractMultiplier?: number | null;
  ownershipShare?: number | null;
  valuationMethod?: 'LINEAR' | null;
  valuationStartDate?: string | null;
  valuationStartPrice?: number | null;
  valuationEndDate?: string | null;
  valuationEndPrice?: number | null;
};

export type Baseline = {
  id: string;
  date: string;
  holdings: Record<string, number>;
  holdingPrices?: Record<string, number>;
  cash: number;
  source?: string;
};

export type Upload = {
  id: string;
  type: 'BASELINE' | 'TRANSACTIONS';
  filename: string;
  uploadedAt: string;
  dateRange?: { start: string; end: string };
  metadata?: Record<string, unknown>;
};

export type ParseTransactionDiagnostics = {
  rowsConsidered: number;
  acceptedRows: number;
  unknownTypeRows: number;
  heuristicClassifiedRows: number;
  unknownTypeRate: number;
  heuristicClassifiedRate: number;
};

export type ParseTransactionResult = {
  accepted: Transaction[];
  errors: Array<{ row: unknown; reason: string }>;
  duplicates: number;
  parseErrors: number;
  diagnostics: ParseTransactionDiagnostics;
};

export type ParseBaselineResult = {
  ok: boolean;
  baseline?: Baseline;
  error?: string;
};

function toIsoDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!match) return '';

  const [, dayRaw, monthRaw, yearRaw] = match;
  const year = yearRaw.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().slice(0, 10);
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = value
    .replace(/[^0-9.\-]/g, '')
    .replace(/(?<!\.)\.(?=.*\.)/g, '')
    .replace(/,(?=\d{3}(?:\D|$))/g, '');

  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseCurrency(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\$,]/g, '')
    .replace(/\s+/g, '')
    .replace(/Cr$/i, '')
    .replace(/Dr$/i, '')
    .trim();
  if (!cleaned || cleaned === '—') return null;
  if (/[.,]$/.test(cleaned)) {
    return null;
  }

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function appendMissingFxReferenceErrors(
  fullText: string,
  source: string,
  accepted: Transaction[],
  errors: Array<{ row: unknown; reason: string }>,
): void {
  const fxReferenceIds = new Set<string>();
  for (const match of fullText.matchAll(/\b(\d{3,})\(FX\)/g)) {
    fxReferenceIds.add(match[1]);
  }

  if (fxReferenceIds.size === 0) {
    return;
  }

  const parsedIds = new Set(accepted.map((tx) => String(tx.id).trim()));
  const missingTradeRefs = [...fxReferenceIds].filter((ref) => !parsedIds.has(ref));
  if (missingTradeRefs.length > 0) {
    errors.push({
      row: source,
      reason: `Missing referenced trade rows for FX settlements: ${missingTradeRefs.slice(0, 15).join(', ')}`,
    });
  }
}

function isStatementNoiseLine(line: string): boolean {
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return true;

  return /^(mr cheo kee jin|trading account statement|period:|date\s+reference\s+description\s+debit\s+credit\s+balance|generated\s*:|page\s+\d+\s+of\s+\d+|this statement and its contents are subject to the terms and conditions|has been made to provide you with an accurate transaction summary|holdings and valuations contained herein|values are denominated in sgd|27 hillview avenue|singapore|09[-\u00ad]?06)$/i.test(compact);
}

function normalizeDescription(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function stripTrailingAmountFromDescription(description: string): string {
  return description
    .replace(/\s+[0-9][0-9,]*(?:\.\d+)?(?:\s*(?:Cr|Dr))?\s*$/i, '')
    .trim();
}

function roundCurrencyValue(value: number): number {
  return Number(value.toFixed(2));
}

function csvSplitLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function extractSymbol(description: string): string | null {
  const match = description.match(/\b([A-Z0-9.-]+):US\b/i);
  if (!match) {
    return null;
  }
  return match[1].toUpperCase();
}

function extractQuantity(description: string): number | null {
  const matches = description.match(/\b(?:Bght|Bought|Sold)\s*(\d+(?:\.\d+)?)\s*[A-Z0-9.-]+:US\b/i);
  if (matches) {
    return Number(matches[1]);
  }

  const sellMatch = description.match(/\bSold\s*(\d+(?:\.\d+)?)\s*[A-Z0-9.-]+:US\b/i);
  if (sellMatch) {
    return Number(sellMatch[1]);
  }

  return null;
}

function extractPrice(description: string): number | null {
  const match = description.match(/@\s*(\d+(?:[\s,]\d{3})*(?:\.\d+)?)\s*(?:SGD|USD)?/i);
  if (!match) return null;
  const num = Number(match[1].replace(/[\s,]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function detectType(description: string): TransactionType | 'UNKNOWN' {
  const normalized = description.toLowerCase();

  if (normalized.includes('bght') || normalized.includes('bought')) return 'BUY';
  if (normalized.includes('sold')) return 'SELL';
  if (normalized.includes('intl div')) return 'DIVIDEND';
  if (normalized.includes('wdl transfer')) return 'WITHDRAWAL';
  if (normalized.includes('deposit') || normalized.includes('dep chassgsg') || normalized.includes('de: dbsssgsg')) return 'DEPOSIT';
  if (normalized.includes('withdrawal') || normalized.includes('wdl chassgsg')) return 'WITHDRAWAL';
  if (normalized.includes('split')) return 'SPLIT';
  return 'UNKNOWN';
}

type ParseRowResult = {
  transaction: Transaction | null;
  unknownType: boolean;
  heuristicClassified: boolean;
};

function parseRow(row: Record<string, string | number | null | undefined>): ParseRowResult {
  const date = toIsoDate(String(row.date ?? '').trim());
  const description = stripTrailingAmountFromDescription(normalizeDescription(String(row.description ?? '')));
  if (!date || !description) {
    return { transaction: null, unknownType: false, heuristicClassified: false };
  }

  const initialType = detectType(description);

  const debit = typeof row.debit === 'number' ? row.debit : parseCurrency(String(row.debit ?? ''));
  const credit = typeof row.credit === 'number' ? row.credit : parseCurrency(String(row.credit ?? ''));

  const symbol = extractSymbol(description);
  const quantity = initialType === 'BUY' || initialType === 'SELL' ? extractQuantity(description) : null;
  const price = initialType === 'BUY' || initialType === 'SELL' ? extractPrice(description) : null;
  const computedTradeValue = (quantity !== null && price !== null) ? roundCurrencyValue(quantity * price) : null;

  let amount = credit !== null ? credit : debit !== null ? -debit : 0;
  if (initialType === 'BUY' || initialType === 'SELL') {
    if (initialType === 'BUY' && debit !== null && computedTradeValue !== null) {
      const delta = Math.abs(debit - computedTradeValue);
      const tolerance = Math.max(5, Math.abs(computedTradeValue) * 0.05);
      amount = delta <= tolerance ? -debit : -computedTradeValue;
    } else if (initialType === 'SELL' && credit !== null && computedTradeValue !== null) {
      const delta = Math.abs(credit - computedTradeValue);
      const tolerance = Math.max(5, Math.abs(computedTradeValue) * 0.05);
      amount = delta <= tolerance ? credit : computedTradeValue;
    } else if (computedTradeValue !== null) {
      amount = initialType === 'BUY' ? -computedTradeValue : computedTradeValue;
    }
  }
  const normalized = description.toLowerCase();

  let type = initialType;
  if (type === 'UNKNOWN' && normalized.includes('exchange fee adjustment')) {
    type = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
  }

  if (type === 'UNKNOWN') {
    return { transaction: null, unknownType: true, heuristicClassified: false };
  }

  const idSource = String(row.reference ?? '').trim() || `${date}-${description}`;

  const tx: Transaction = {
    id: idSource,
    date,
    type,
    symbol: type === 'DEPOSIT' || type === 'WITHDRAWAL' ? null : symbol,
    quantity,
    price,
    amount,
    splitRatio: null,
    rawDescription: description,
    source: String(row.source ?? ''),
  };

  if ((type === 'BUY' || type === 'SELL' || type === 'DIVIDEND' || type === 'SPLIT') && !tx.symbol) {
    return { transaction: null, unknownType: false, heuristicClassified: false };
  }

  const heuristicClassified = (type === 'DEPOSIT' || type === 'WITHDRAWAL')
    && !normalized.includes('dep chassgsg')
    && !normalized.includes('wdl chassgsg')
    && !normalized.includes('de: dbsssgsg');

  return { transaction: tx, unknownType: false, heuristicClassified };
}

export function parseTransactionText(text: string, source: string): ParseTransactionResult {
  const accepted: Transaction[] = [];
  const errors: Array<{ row: unknown; reason: string }> = [];
  let rowsConsidered = 0;
  let unknownTypeRows = 0;
  let heuristicClassifiedRows = 0;

  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);

  const csvHeader = lines.find((line) => line.toLowerCase().includes('date') && line.toLowerCase().includes('description'));
  if (csvHeader && csvHeader.includes(',')) {
    const headerCells = csvSplitLine(csvHeader).map((cell) => cell.toLowerCase().trim());
    const findIndex = (needle: string) => headerCells.findIndex((cell) => cell.includes(needle));
    const dateIndex = findIndex('date');
    const descriptionIndex = findIndex('description');
    const referenceIndex = findIndex('reference');
    const debitIndex = findIndex('debit');
    const creditIndex = findIndex('credit');

    const csvRows = lines.slice(lines.indexOf(csvHeader) + 1).filter((line) => line.length > 0);
    for (const line of csvRows) {
      const cells = csvSplitLine(line);
      if (cells.length < 3) continue;
      const row = {
        date: dateIndex >= 0 ? cells[dateIndex] : cells[0],
        reference: referenceIndex >= 0 ? cells[referenceIndex] : '',
        description: descriptionIndex >= 0 ? cells[descriptionIndex] : cells[1],
        debit: debitIndex >= 0 ? cells[debitIndex] : cells[2],
        credit: creditIndex >= 0 ? cells[creditIndex] : cells[3],
      };
      rowsConsidered += 1;
      const parsedRow = parseRow({ ...row, source });
      if (parsedRow.unknownType) {
        unknownTypeRows += 1;
        errors.push({ row: line, reason: 'Unknown transaction type from description' });
        continue;
      }
      if (!parsedRow.transaction) {
        errors.push({ row: line, reason: 'Unable to parse transaction row' });
        continue;
      }
      if (parsedRow.heuristicClassified) {
        heuristicClassifiedRows += 1;
      }
      accepted.push(parsedRow.transaction);
    }
    appendMissingFxReferenceErrors(text, source, accepted, errors);
    return {
      accepted,
      errors,
      duplicates: 0,
      parseErrors: errors.length,
      diagnostics: {
        rowsConsidered,
        acceptedRows: accepted.length,
        unknownTypeRows,
        heuristicClassifiedRows,
        unknownTypeRate: rowsConsidered === 0 ? 0 : unknownTypeRows / rowsConsidered,
        heuristicClassifiedRate: rowsConsidered === 0 ? 0 : heuristicClassifiedRows / rowsConsidered,
      },
    };
  }

  const statementHeaderLine = rawLines.find(
    (line) => /\bDate\b/i.test(line)
      && /\bReference\b/i.test(line)
      && /\bDescription\b/i.test(line)
      && /\bDebit\b/i.test(line)
      && /\bCredit\b/i.test(line)
      && /\bBalance\b/i.test(line),
  );

  if (statementHeaderLine) {
    const referenceStart = statementHeaderLine.indexOf('Reference');
    const descriptionStart = statementHeaderLine.indexOf('Description');
    const debitStart = statementHeaderLine.indexOf('Debit');
    const creditStart = statementHeaderLine.indexOf('Credit');
    const balanceStart = statementHeaderLine.indexOf('Balance');

    if (referenceStart >= 0 && descriptionStart > referenceStart && debitStart > descriptionStart && creditStart > debitStart && balanceStart > creditStart) {
      const statementRows: string[] = [];
      const localAccepted: Transaction[] = [];
      const localErrors: Array<{ row: unknown; reason: string }> = [];
      let localRowsConsidered = 0;
      let localUnknownTypeRows = 0;
      let localHeuristicClassifiedRows = 0;

      type StatementRow = { base: string; continuation: string[] };
      const statementRowParts: StatementRow[] = [];
      let currentRow: StatementRow | null = null;
      for (const rawLine of rawLines) {
        if (/^\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s+/.test(rawLine)) {
          if (currentRow) {
            statementRowParts.push(currentRow);
          }
          currentRow = { base: rawLine, continuation: [] };
          continue;
        }

        if (!currentRow) {
          continue;
        }

        if (isStatementNoiseLine(rawLine)) {
          continue;
        }

        currentRow.continuation.push(rawLine.trim());
      }
      if (currentRow) {
        statementRowParts.push(currentRow);
      }

      for (const rowPart of statementRowParts) {
        const debitValue = rowPart.base.slice(debitStart, creditStart).trim();
        const creditValue = rowPart.base.slice(creditStart, balanceStart).trim();
        const baseDescription = rowPart.base.slice(descriptionStart, debitStart).replace(/\s+/g, ' ').trim();

        const mergedDescription = `${baseDescription} ${rowPart.continuation.join(' ')}`.replace(/\s+/g, ' ').trim();
        const compact = `${rowPart.base} ${rowPart.continuation.join(' ')}`.replace(/\s+/g, ' ').trim();

        statementRows.push([
          rowPart.base.slice(0, referenceStart).trim(),
          rowPart.base.slice(referenceStart, descriptionStart).trim(),
          mergedDescription,
          debitValue,
          creditValue,
          compact,
        ].join('\t'));
      }

      for (const rawLine of statementRows) {
        const [date, reference, description, debit, credit, compact] = rawLine.split('\t');
        if (/\bopen balance\b|\bclosing balance\b/i.test(compact)) {
          continue;
        }
        const normalizedTail = description.toLowerCase();
        if (normalizedTail.includes('open balance') || normalizedTail.includes('closing balance')) {
          continue;
        }

        const row = {
          date,
          reference,
          description,
          debit,
          credit,
        };

        localRowsConsidered += 1;
        const parsedRow = parseRow({ ...row, source });
        if (parsedRow.unknownType) {
          localUnknownTypeRows += 1;
          localErrors.push({ row: compact, reason: 'Unknown transaction type from description' });
          continue;
        }
        if (!parsedRow.transaction) {
          localErrors.push({ row: compact, reason: 'Unable to parse extracted statement row' });
          continue;
        }

        if (parsedRow.heuristicClassified) {
          localHeuristicClassifiedRows += 1;
        }
        localAccepted.push(parsedRow.transaction);
      }

      // If fixed-column extraction did not yield any parseable transactions,
      // fall through to the more permissive line parser below.
      if (localAccepted.length > 0) {
        appendMissingFxReferenceErrors(text, source, localAccepted, localErrors);
        return {
          accepted: localAccepted,
          errors: localErrors,
          duplicates: 0,
          parseErrors: localErrors.length,
          diagnostics: {
            rowsConsidered: localRowsConsidered,
            acceptedRows: localAccepted.length,
            unknownTypeRows: localUnknownTypeRows,
            heuristicClassifiedRows: localHeuristicClassifiedRows,
            unknownTypeRate: localRowsConsidered === 0 ? 0 : localUnknownTypeRows / localRowsConsidered,
            heuristicClassifiedRate: localRowsConsidered === 0 ? 0 : localHeuristicClassifiedRows / localRowsConsidered,
          },
        };
      }
    }
  }

  const extracted: Array<{ date: string; reference: string; description: string; debit: string; credit: string }> = [];

  for (const line of lines) {
    const dateMatch = line.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+/);
    if (!dateMatch) {
      continue;
    }

    if (/\bopen balance\b|\bclosing balance\b/i.test(line)) {
      continue;
    }

    const compact = line.replace(/\s+/g, ' ').trim();
    const headMatch = compact.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+([^\s]+)\s+(.*)$/);
    if (!headMatch) {
      continue;
    }

    const [, date, reference, tailRaw] = headMatch;
    const tail = tailRaw.trim();

    // Support both:
    // 1) "... <amount> <balance>" (common CMC statement rows)
    // 2) "... <amount>" (converted transaction text rows)
    const trailingTokensMatch = tail.match(
      /(?:^|\s)([0-9][0-9,]*(?:\.\d+)?(?:Cr|Dr)?)(?:\s+([0-9][0-9,]*(?:\.\d+)?(?:Cr|Dr)?))?$/i,
    );
    if (!trailingTokensMatch) {
      continue;
    }

    const amountTokenRaw = trailingTokensMatch[2] ? trailingTokensMatch[1] : trailingTokensMatch[1];
    const amountTokenCandidate = trailingTokensMatch[2] ? trailingTokensMatch[1] : trailingTokensMatch[1];
    const amountToken = String(amountTokenCandidate).replace(/(Cr|Dr)$/i, '');
    if (!/^\d[\d,]*(?:\.\d+)?$/.test(amountToken)) {
      continue;
    }

    const description = trailingTokensMatch[2]
      ? tail.slice(0, tail.length - (` ${trailingTokensMatch[1]} ${trailingTokensMatch[2]}`).length).trim()
      : tail.slice(0, tail.length - (` ${amountTokenRaw}`).length).trim();
    const type = detectType(description);
    if (type === 'UNKNOWN') {
      rowsConsidered += 1;
      unknownTypeRows += 1;
      errors.push({ row: compact, reason: 'Unknown transaction type from description' });
      continue;
    }

    const debit = type === 'BUY' || type === 'WITHDRAWAL' ? amountToken : '';
    const credit = debit ? '' : amountToken;

    if (!reference && !description) {
      continue;
    }

    extracted.push({
      date,
      reference,
      description,
      debit,
      credit,
    });
  }

  for (const row of extracted) {
    rowsConsidered += 1;
    const parsed = parseRow({
      date: row.date,
      reference: row.reference,
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      source,
    });

    if (parsed.unknownType) {
      unknownTypeRows += 1;
      errors.push({ row, reason: 'Unknown transaction type from description' });
      continue;
    }

    if (!parsed.transaction) {
      errors.push({ row, reason: 'Unable to parse extracted statement row' });
      continue;
    }

    if (parsed.heuristicClassified) {
      heuristicClassifiedRows += 1;
    }
    accepted.push(parsed.transaction);
  }

  appendMissingFxReferenceErrors(text, source, accepted, errors);

  return {
    accepted,
    errors,
    duplicates: 0,
    parseErrors: errors.length,
    diagnostics: {
      rowsConsidered,
      acceptedRows: accepted.length,
      unknownTypeRows,
      heuristicClassifiedRows,
      unknownTypeRate: rowsConsidered === 0 ? 0 : unknownTypeRows / rowsConsidered,
      heuristicClassifiedRate: rowsConsidered === 0 ? 0 : heuristicClassifiedRows / rowsConsidered,
    },
  };
}

export function parseBaselineText(text: string, source: string): ParseBaselineResult {
  const lines = text.split(/\r?\n/);

  const dateMatch = text.match(/At Close of Trading Day:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i)
    ?? text.match(/as at\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);
  if (!dateMatch) {
    return { ok: false, error: 'Could not find baseline date in uploaded report.' };
  }

  const baselineDate = toIsoDate(dateMatch[1]);
  if (!baselineDate) {
    return { ok: false, error: 'Baseline date could not be parsed.' };
  }

  const holdings: Record<string, number> = {};
  const holdingPrices: Record<string, number> = {};

  for (const line of lines) {
    const match = line.match(/\b([A-Z0-9.-]+:US)\b[^\n]*?\s+(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s+(\d+(?:,\d{3})*(?:\.\d+)?)USD/i);
    if (!match) {
      continue;
    }

    const symbol = match[1].toUpperCase().replace(/:US$/i, '');
    const quantity = Number(String(match[2]).replace(/,/g, ''));
    const price = Number(String(match[3]).replace(/,/g, ''));
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) {
      continue;
    }

    holdings[symbol] = quantity;
    holdingPrices[symbol] = price;
  }

  const cashLine = lines
    .find((line) => /Bank Balance/i.test(line))
    ?.match(/([\d,]+\.\d{2})/);

  const cash = cashLine ? Number(cashLine[1].replace(/,/g, '')) : 0;

  if (Object.keys(holdings).length === 0) {
    return { ok: false, error: 'No holdings were found in the baseline report.' };
  }

  return {
    ok: true,
    baseline: {
      id: `baseline-${baselineDate}`,
      date: baselineDate,
      holdings,
      holdingPrices,
      cash,
      source,
    },
  };
}

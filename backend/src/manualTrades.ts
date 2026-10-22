import type { Transaction } from './parsers.js';

export type InstrumentType = 'EQUITY' | 'OPTION';
export type OptionType = 'CALL' | 'PUT';

export type ManualTradeInput = {
  date: string;
  type: 'BUY' | 'SELL';
  instrumentType?: InstrumentType;
  symbol?: string;
  underlyingSymbol?: string;
  optionType?: OptionType;
  strikePrice?: number;
  expiryDate?: string;
  quantity: number;
  price: number;
  amount?: number;
  contractMultiplier?: number;
  ownershipShare?: number;
  valuationMethod?: 'LINEAR';
  valuationStartDate?: string;
  valuationStartPrice?: number;
  valuationStartAmount?: number;
  valuationEndDate?: string;
  valuationEndPrice?: number;
  valuationEndAmount?: number;
  source?: string;
};

export function buildOptionContractSymbol(
  underlyingSymbol: string,
  expiryDate: string,
  strikePrice: number,
  optionType: OptionType,
): string {
  const normalizedSymbol = underlyingSymbol.trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error('An underlying symbol is required to build an option contract symbol.');
  }

  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.test(expiryDate);
  const expiryText = isoMatch ? expiryDate.replace(/-/g, '').slice(2) : String(expiryDate).replace(/[^0-9]/g, '');
  if (!expiryText || expiryText.length < 6) {
    throw new Error('A valid expiry date is required to build an option contract symbol.');
  }

  const strikeValue = Number(strikePrice);
  if (!Number.isFinite(strikeValue)) {
    throw new Error('A valid strike price is required to build an option contract symbol.');
  }

  const strikeToken = Math.round(strikeValue * 1000)
    .toString()
    .padStart(8, '0');

  const optionLetter = optionType.toUpperCase() === 'PUT' ? 'P' : 'C';
  return `${normalizedSymbol}${expiryText}${optionLetter}${strikeToken}`;
}

export function buildManualTransaction(input: ManualTradeInput): Transaction {
  const date = input.date;
  if (!date) {
    throw new Error('A trade date is required.');
  }

  const type = input.type;
  const quantity = Number(input.quantity ?? 0);
  const price = Number(input.price ?? 0);
  const instrumentType = input.instrumentType ?? (input.optionType || input.underlyingSymbol || input.expiryDate || input.strikePrice ? 'OPTION' : 'EQUITY');

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Manual trade quantity must be a positive number.');
  }

  if (!Number.isFinite(price) || price < 0) {
    throw new Error('Manual trade price must be zero or greater.');
  }

  const source = input.source ?? 'manual-entry';
  const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (instrumentType === 'OPTION') {
    const underlyingSymbol = (input.underlyingSymbol ?? input.symbol ?? '').trim().toUpperCase();
    if (!underlyingSymbol) {
      throw new Error('An underlying symbol is required for option trades.');
    }

    const optionType = input.optionType ?? 'CALL';
    const expiryDate = input.expiryDate ?? date;
    const strikePrice = Number(input.strikePrice ?? 0);
    const contractMultiplier = Number(input.contractMultiplier ?? 100);
    const ownershipShare = Number(input.ownershipShare ?? 1);

    if (!Number.isFinite(ownershipShare) || ownershipShare <= 0 || ownershipShare > 1) {
      throw new Error('Ownership share must be greater than 0 and at most 1.');
    }

    const symbol = buildOptionContractSymbol(underlyingSymbol, expiryDate, strikePrice, optionType);
    const effectiveQuantity = quantity * ownershipShare;
    const tradeAmount = effectiveQuantity * price * contractMultiplier;

    let linearStartPrice: number | null = null;
    let linearEndPrice: number | null = null;

    if (input.valuationMethod === 'LINEAR') {
      const valuationStartPrice = Number(input.valuationStartPrice);
      const valuationEndPrice = Number(input.valuationEndPrice);
      const valuationStartAmount = Number(input.valuationStartAmount);
      const valuationEndAmount = Number(input.valuationEndAmount);
      const hasPriceInputs = Number.isFinite(valuationStartPrice) && Number.isFinite(valuationEndPrice);
      const hasAmountInputs = Number.isFinite(valuationStartAmount) && Number.isFinite(valuationEndAmount);

      if (!input.valuationStartDate || !input.valuationEndDate) {
        throw new Error('Linear valuation requires start and end dates.');
      }

      if (!hasPriceInputs && !hasAmountInputs) {
        throw new Error('Linear valuation requires either start/end prices or start/end booked amounts.');
      }

      if (hasPriceInputs) {
        linearStartPrice = valuationStartPrice;
        linearEndPrice = valuationEndPrice;
      } else {
        const notionalUnits = quantity * contractMultiplier;
        if (!Number.isFinite(notionalUnits) || notionalUnits <= 0) {
          throw new Error('Linear valuation amount conversion requires a valid quantity and contract multiplier.');
        }
        if (valuationStartAmount < 0 || valuationEndAmount < 0) {
          throw new Error('Linear valuation booked amounts must be zero or greater.');
        }

        linearStartPrice = valuationStartAmount / notionalUnits;
        linearEndPrice = valuationEndAmount / notionalUnits;
      }
    }

    return {
      id,
      date,
      type,
      symbol,
      quantity: effectiveQuantity,
      price,
      amount: type === 'BUY' ? -tradeAmount : tradeAmount,
      splitRatio: null,
      source,
      rawDescription: `${type} ${symbol} manual entry`,
      instrumentType: 'OPTION',
      underlyingSymbol,
      optionType,
      strikePrice,
      expiryDate,
      contractMultiplier,
      ownershipShare,
      valuationMethod: input.valuationMethod ?? null,
      valuationStartDate: input.valuationStartDate ?? null,
      valuationStartPrice: linearStartPrice,
      valuationEndDate: input.valuationEndDate ?? null,
      valuationEndPrice: linearEndPrice,
    };
  }

  const symbol = (input.symbol ?? '').trim().toUpperCase();
  if (!symbol) {
    throw new Error('A symbol is required for equity trades.');
  }

  const tradeAmount = Number(input.amount ?? quantity * price);
  const normalizedAmount = Number.isFinite(tradeAmount) ? tradeAmount : quantity * price;

  return {
    id,
    date,
    type,
    symbol,
    quantity,
    price,
    amount: type === 'BUY' ? -Math.abs(normalizedAmount) : Math.abs(normalizedAmount),
    splitRatio: null,
    source,
    rawDescription: `${type} ${symbol} manual entry`,
    instrumentType: 'EQUITY',
    underlyingSymbol: symbol,
  };
}
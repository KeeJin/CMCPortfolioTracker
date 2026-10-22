import type { RawTransactionRow } from './types'

function parseNumberCell(value: string | undefined): number | null {
  if (!value) return null

  const trimmed = value.trim().replace(/,/g, '')
  if (!trimmed) return null

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]

    if (char === '"') {
      const next = line[index + 1]
      if (inQuotes && next === '"') {
        current += '"'
        index += 1
        continue
      }

      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  values.push(current.trim())
  return values
}

function parseJsonRows(content: string): RawTransactionRow[] {
  const parsed = JSON.parse(content) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('JSON transaction file must be an array of rows')
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Row ${index + 1} is not an object`)
    }

    const row = item as Record<string, unknown>
    if (
      typeof row.date !== 'string' ||
      typeof row.reference !== 'string' ||
      typeof row.description !== 'string'
    ) {
      throw new Error(`Row ${index + 1} is missing required fields`)
    }

    const debit = row.debit == null ? null : Number(row.debit)
    const credit = row.credit == null ? null : Number(row.credit)

    return {
      date: row.date,
      reference: row.reference,
      description: row.description,
      debit: Number.isFinite(debit) ? debit : null,
      credit: Number.isFinite(credit) ? credit : null,
    }
  })
}

function parseCsvRows(content: string): RawTransactionRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    throw new Error('CSV file must include a header row and at least one data row')
  }

  const headers = parseCsvLine(lines[0]).map((value) => value.toLowerCase())
  const requiredHeaders = ['date', 'reference', 'description', 'debit', 'credit']

  for (const header of requiredHeaders) {
    if (!headers.includes(header)) {
      throw new Error(`CSV header must include ${header}`)
    }
  }

  return lines
    .slice(1)
    .map((line, index) => {
      const values = parseCsvLine(line)
      const row = Object.fromEntries(
        headers.map((header, headerIndex) => [header, values[headerIndex] ?? '']),
      )

      if (!row.date || !row.reference || !row.description) {
        throw new Error(`CSV row ${index + 2} is missing required fields`)
      }

      return {
        date: row.date,
        reference: row.reference,
        description: row.description,
        debit: parseNumberCell(row.debit),
        credit: parseNumberCell(row.credit),
      }
    })
}

export function parseTransactionFile(content: string): RawTransactionRow[] {
  const trimmed = content.trim()

  if (!trimmed) {
    throw new Error('Transaction file is empty')
  }

  if (trimmed.startsWith('[')) {
    return parseJsonRows(trimmed)
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.toLowerCase() ?? ''
  if (firstLine.includes('date') && firstLine.includes('reference') && firstLine.includes(',')) {
    return parseCsvRows(trimmed)
  }

  throw new Error('Transactions upload currently supports CSV or JSON files only')
}

export async function readTextFile(file: File): Promise<string> {
  return file.text()
}

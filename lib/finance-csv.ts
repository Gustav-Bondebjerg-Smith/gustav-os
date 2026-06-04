// Parser for dansk bank-CSV (Modul 4). Format bekræftet mod Gustavs egen eksport:
//   ISO-8859-1, semikolon-separeret, komma-decimal, dato DD-MM-YYYY, INGEN header.
// Kolonner (0-indekseret): 0 konto, 1 konto, 2 ref, 3 dato, 4 tekst, 5 beløb,
//   6 saldo, 7 modpart, 8 detalje (Forretning/By/Terminal/Kortnr), 9 (tom).
// ISO-8859-1 -> string-dekodning sker ved I/O-grænsen (script/server action), så
// denne parser tager en FÆRDIG-DEKODET streng. Ren funktion, ingen I/O.
import { cleanText, type ParsedBankTx } from './finance-shared'

// Split én CSV-linje på ';' men respektér "..."-citerede felter.
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++ // escaped ""
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

// "-1.234,56" / " 16762,13" -> number. '.' = tusind-separator, ',' = decimal.
export function parseDanishNumber(raw: string): number | null {
  const s = (raw || '').trim().replace(/\./g, '').replace(',', '.')
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// "01-05-2024" -> "2024-05-01"
function parseDanishDate(raw: string): string | null {
  const m = (raw || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

export function parseBankCsv(text: string): ParsedBankTx[] {
  const out: ParsedBankTx[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const f = splitCsvLine(line)
    if (f.length < 7) continue // ufuldstændig linje
    const bookedDate = parseDanishDate(f[3] ?? '')
    const amount = parseDanishNumber(f[5] ?? '')
    if (!bookedDate || amount === null) continue // header/skrald -> spring over
    out.push({
      bookedDate,
      textRaw: cleanText(f[4]),
      amount,
      balance: parseDanishNumber(f[6] ?? ''),
      counterparty: cleanText(f[7]),
      detail: cleanText(f[8]),
      ref: cleanText(f[2]),
    })
  }
  return out
}

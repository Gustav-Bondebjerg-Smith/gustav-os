// Klient-sikre returtyper for finans-siderns server actions. Adskilt fra
// actions.ts (`'use server'`-filer må kun eksportere async funktioner).
export type FinanceActionResult = { ok: boolean; message?: string }
export type ImportResult = { ok: boolean; message?: string }

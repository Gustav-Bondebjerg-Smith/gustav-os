// Brugerdefinerede synder (sin_tags) til Modul 4. Spejler lib/finance-categories.ts:
// Gustav kan tilfoeje egne synder oven paa de faste (SIN_TAGS). De lagres som fakta i
// memory_facts - ÉT faktum pr. synd: key = noegle, content = visningsnavn - i sit EGET
// scope (finance_sin), adskilt fra kategorier (finance_cat) og forretnings-regler
// (finance). Ingen migration: transactions/transaction_lines.sin_tag er fri text.
import 'server-only'
import { SIN_TAGS, SIN_LABEL, type SinDef } from './finance-shared'
import { recallForScope, saveMemory, deleteMemory } from './memory-facts'
import { slugifyCategoryKey } from './finance-categories'

const SIN_SCOPE = 'finance_sin'
const BUILTIN_SIN_KEYS = new Set<string>(SIN_TAGS as readonly string[])

// Faste + brugerdefinerede synder. Faste foerst (vant raekkefoelge), egne derefter
// alfabetisk. Fejler bloedt til kun-faste, saa et DB-problem ikke vaelter synd-menuerne.
export async function loadSins(): Promise<SinDef[]> {
  const builtin: SinDef[] = (SIN_TAGS as readonly string[]).map((k) => ({
    key: k,
    label: SIN_LABEL[k] ?? k,
    builtin: true,
  }))
  let custom: SinDef[] = []
  try {
    const res = await recallForScope(SIN_SCOPE)
    if (res.mode === 'all') {
      custom = res.rows
        .filter((r) => !BUILTIN_SIN_KEYS.has(r.key))
        .map((r) => ({ key: r.key, label: (r.content || r.key).trim(), builtin: false }))
      custom.sort((a, b) => a.label.localeCompare(b.label, 'da'))
    }
  } catch (e) {
    console.error('loadSins fejlede (kun faste):', e)
  }
  return [...builtin, ...custom]
}

// Tilfoej en brugerdefineret synd. Returnerer noeglen ved succes, ellers en besked.
// Genbruger slugifyCategoryKey (ren funktion): noeglen holdes til [a-z] saa den
// overlever parseFinanceRule's sin=([a-zæøå]+)-udtraek.
export async function addSin(
  label: string,
): Promise<{ ok: boolean; key?: string; message?: string }> {
  const clean = (label || '').trim().replace(/\s+/g, ' ')
  if (!clean) return { ok: false, message: 'Skriv et navn.' }
  if (clean.length > 30) return { ok: false, message: 'Maks 30 tegn.' }
  const key = slugifyCategoryKey(clean)
  if (!key) return { ok: false, message: 'Navnet skal indeholde bogstaver (a-z).' }
  const existing = await loadSins()
  if (existing.some((s) => s.key === key)) return { ok: false, message: 'Synden findes allerede.' }
  await saveMemory({
    type: 'reference',
    scope: SIN_SCOPE,
    key,
    content: clean,
    why: 'Brugerdefineret synd',
  })
  return { ok: true, key }
}

// Slet en brugerdefineret synd. Faste kan ikke slettes (data + AI peger paa dem).
// Eksisterende posteringer/linjer beholder vaerdien (vises som raa noegle til de rettes).
export async function deleteSin(key: string): Promise<{ ok: boolean; message?: string }> {
  if (!key) return { ok: false, message: 'Ukendt synd.' }
  if (BUILTIN_SIN_KEYS.has(key)) return { ok: false, message: 'Faste synder kan ikke slettes.' }
  await deleteMemory({ scope: SIN_SCOPE, key })
  return { ok: true }
}

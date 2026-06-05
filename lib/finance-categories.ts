// Brugerdefinerede finans-kategorier (Modul 4). Gustav kan tilfoeje egne kategorier
// oven paa de faste (CATEGORIES). De lagres som fakta i memory_facts - ÉT faktum pr.
// kategori: key = noegle, content = visningsnavn - i sit EGET scope (finance_cat),
// adskilt fra forretnings-reglerne (scope 'finance'), saa loadFinanceRules ikke
// forurenes. Ingen migration: memory_facts findes, og transactions.category er fri text.
import 'server-only'
import { CATEGORIES, CATEGORY_LABEL, type CategoryDef } from './finance-shared'
import { recallForScope, saveMemory, deleteMemory } from './memory-facts'

const CAT_SCOPE = 'finance_cat'
const BUILTIN_KEYS = new Set<string>(CATEGORIES as readonly string[])
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')

// Udled en stabil noegle fra et navn: ASCII-bogstaver (a-z), uden tegn/tal/mellemrum.
// Danske bogstaver mappes (o/ae/a) FOER diakritik-strip, saa "Boern" -> "born" og
// ikke "brn". Noeglen holdes til [a-z] saa den overlever parseFinanceRule-udtraekket
// og aldrig kolliderer med tal/tegn.
export function slugifyCategoryKey(label: string): string {
  return (label || '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/[^a-z]/g, '')
}

// Faste + brugerdefinerede. Faste foerst (vant raekkefoelge), egne derefter alfabetisk.
// Fejler bloedt til kun-faste, saa et DB-problem ikke vaelter kategori-menuerne.
export async function loadCategories(): Promise<CategoryDef[]> {
  const builtin: CategoryDef[] = (CATEGORIES as readonly string[]).map((k) => ({
    key: k,
    label: CATEGORY_LABEL[k] ?? k,
    builtin: true,
  }))
  let custom: CategoryDef[] = []
  try {
    const res = await recallForScope(CAT_SCOPE)
    if (res.mode === 'all') {
      custom = res.rows
        .filter((r) => !BUILTIN_KEYS.has(r.key))
        .map((r) => ({ key: r.key, label: (r.content || r.key).trim(), builtin: false }))
      custom.sort((a, b) => a.label.localeCompare(b.label, 'da'))
    }
  } catch (e) {
    console.error('loadCategories fejlede (kun faste):', e)
  }
  return [...builtin, ...custom]
}

// Tilfoej en brugerdefineret kategori. Returnerer noeglen ved succes, ellers en besked.
export async function addCategory(
  label: string,
): Promise<{ ok: boolean; key?: string; message?: string }> {
  const clean = (label || '').trim().replace(/\s+/g, ' ')
  if (!clean) return { ok: false, message: 'Skriv et navn.' }
  if (clean.length > 30) return { ok: false, message: 'Maks 30 tegn.' }
  const key = slugifyCategoryKey(clean)
  if (!key) return { ok: false, message: 'Navnet skal indeholde bogstaver (a-z).' }
  const existing = await loadCategories()
  if (existing.some((c) => c.key === key)) return { ok: false, message: 'Kategorien findes allerede.' }
  await saveMemory({
    type: 'reference',
    scope: CAT_SCOPE,
    key,
    content: clean,
    why: 'Brugerdefineret finans-kategori',
  })
  return { ok: true, key }
}

// Slet en brugerdefineret kategori. Faste kan ikke slettes (data + AI peger paa dem).
// Eksisterende posteringer beholder vaerdien (vises som raa noegle til de rettes).
export async function deleteCategory(key: string): Promise<{ ok: boolean; message?: string }> {
  if (!key) return { ok: false, message: 'Ukendt kategori.' }
  if (BUILTIN_KEYS.has(key)) return { ok: false, message: 'Faste kategorier kan ikke slettes.' }
  await deleteMemory({ scope: CAT_SCOPE, key })
  return { ok: true }
}

// Gustav OS - mad/opskrifter (helbreds-modul, fase 1).
//
// Én verb (suggest_meal i agent-router) -> suggestMeal(): returnerer EN konkret
// opskrift, enten fra kataloget (recipes-tabellen) eller nygenereret. Genererede
// opskrifter gemmes tilbage i kataloget, saa det vokser af sig selv. Server-only,
// alt gaar via service_role (getSupabase), praecis som resten af systemet.
//
// MAKRO-KRAV (Gustavs valg): hver ret er proteintung. Maal-ratio ca. 15 kcal pr.
// gram protein (3000 kcal / 200 g protein hvis hele retten var dagens eneste mad).
// Behoever ikke ramme praecist, men ratioen skal holde (protein ~25-30% af kcal).
import 'server-only'
import { getSupabase } from './supabase'
import { recallGlobal, formatGlobalForPrompt } from './memory-facts'

const MEAL_MODEL = 'claude-haiku-4-5-20251001'

export type Meal = 'morgenmad' | 'frokost' | 'aftensmad' | 'snack'
const MEALS: Meal[] = ['morgenmad', 'frokost', 'aftensmad', 'snack']

export interface Recipe {
  id?: string
  title: string
  meal: Meal
  source?: 'generated' | 'manual'
  kcal: number | null
  protein_g: number | null
  total_minutes: number | null
  servings: number | null
  ingredients: string[]
  steps: string[]
  tags: string[]
  notes?: string | null
}

function isMeal(v: string): v is Meal {
  return (MEALS as string[]).includes(v)
}

// Map frit/engelsk input til vores maaltids-enum. Default aftensmad.
function normalizeMeal(raw: string): Meal {
  const v = raw.trim().toLowerCase()
  if (v === 'breakfast' || v === 'morgen' || v === 'morgenmad') return 'morgenmad'
  if (v === 'lunch' || v === 'frokost') return 'frokost'
  if (v === 'snack' || v === 'mellemmaaltid' || v === 'mellemmåltid') return 'snack'
  return isMeal(v) ? v : 'aftensmad'
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n) : null
}

// Normaliseret titel til dedup (saa naer-dubletter ikke fylder kataloget op).
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Robust JSON-udtraek: scan balancerede {} og respektér strenge. ALDRIG fence-strip
// (Haiku pakker nogle gange svaret i ```json OG tilfoejer prosa efter objektet, jf.
// AGENTS.md). Holdt lokal her for at undgaa cirkulaer import med telegram-webhook.ts.
function extractJsonObject<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function anthropic(system: string, user: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('Mangler ANTHROPIC_API_KEY i env')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MEAL_MODEL,
      max_tokens: 1100,
      temperature: 0.6,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return String(j.content?.[0]?.text || '').trim()
}

function rowToRecipe(row: Record<string, unknown>): Recipe {
  return {
    id: row.id != null ? String(row.id) : undefined,
    title: String(row.title ?? ''),
    meal: isMeal(String(row.meal)) ? (String(row.meal) as Meal) : 'aftensmad',
    source: row.source === 'manual' ? 'manual' : 'generated',
    kcal: numOrNull(row.kcal),
    protein_g: numOrNull(row.protein_g),
    total_minutes: numOrNull(row.total_minutes),
    servings: numOrNull(row.servings),
    ingredients: Array.isArray(row.ingredients) ? (row.ingredients as unknown[]).map(String) : [],
    steps: Array.isArray(row.steps) ? (row.steps as unknown[]).map(String) : [],
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    notes: row.notes != null ? String(row.notes) : null,
  }
}

// Mindst nyligt foreslaaet opskrift for det rette maaltid (variation). Fejler
// bloedt til null, saa et tomt/manglende katalog bare giver en genereret opskrift.
async function pickFromCatalog(meal: Meal): Promise<Recipe | null> {
  try {
    const sb = getSupabase()
    const { data, error } = await sb
      .from('recipes')
      .select('*')
      .eq('meal', meal)
      .order('last_suggested_at', { ascending: true, nullsFirst: true })
      .limit(1)
    if (error) throw new Error(error.message)
    const row = data?.[0]
    return row ? rowToRecipe(row as Record<string, unknown>) : null
  } catch (e) {
    console.error('pickFromCatalog fejlede (genererer i stedet):', e)
    return null
  }
}

async function bumpSuggested(id: string): Promise<void> {
  try {
    const sb = getSupabase()
    await sb.from('recipes').update({ last_suggested_at: new Date().toISOString() }).eq('id', id)
  } catch (e) {
    console.error('bumpSuggested fejlede (ignoreret):', e)
  }
}

// Gem en genereret opskrift tilbage i kataloget. Best-effort + dedup paa
// normaliseret titel: en fejl maa ALDRIG blokere selve forslaget til Gustav.
async function saveRecipe(r: Recipe): Promise<string | null> {
  try {
    const sb = getSupabase()
    const { data: existing } = await sb.from('recipes').select('id, title')
    const norm = normalizeTitle(r.title)
    const dupe = (existing || []).find(
      (row: { id: string; title: string }) => normalizeTitle(row.title) === norm
    )
    if (dupe) {
      await bumpSuggested(String(dupe.id))
      return String(dupe.id)
    }
    const { data, error } = await sb
      .from('recipes')
      .insert({
        title: r.title,
        meal: r.meal,
        source: r.source ?? 'generated',
        kcal: r.kcal,
        protein_g: r.protein_g,
        total_minutes: r.total_minutes,
        servings: r.servings,
        ingredients: r.ingredients,
        steps: r.steps,
        tags: r.tags,
        last_suggested_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    return String(data.id)
  } catch (e) {
    console.error('saveRecipe fejlede (ignoreret):', e)
    return null
  }
}

async function generateRecipe(
  meal: Meal,
  constraints: string | undefined,
  factsBlock: string
): Promise<Recipe> {
  const system = [
    "Du er Gustav OS' kok. Lav ÉN konkret dansk hverdagsopskrift til én person.",
    'MAKRO-KRAV (vigtigst): retten skal vaere proteintung. Sigt efter 3000 kcal og 200 g protein for HELE retten (ca. 15 kcal pr. gram protein). Den behoever ikke ramme praecist, men ratioen skal holde: protein skal udgoere ca. 25-30% af kalorierne. Hellere lidt for meget protein end for lidt.',
    'Brug almindelige danske dagligvarer. Ingen eksotiske specialindkoeb.',
    factsBlock || '',
    factsBlock
      ? 'Respektér fakta ovenfor som HAARDE krav, isaer allergier og ting Gustav ikke spiser.'
      : '',
    'Skriv aldrig em-dashes. Brug punktum eller bindestreg.',
    'Returnér KUN ét JSON-objekt og intet andet, paa formen:',
    '{"title": str, "meal": "morgenmad|frokost|aftensmad|snack", "kcal": int (hele retten), "protein_g": int (hele retten), "total_minutes": int, "servings": int, "ingredients": [str med maengde], "steps": [str], "tags": [str]}',
  ]
    .filter(Boolean)
    .join('\n')

  const user = JSON.stringify({
    maaltid: meal,
    oenske: constraints || null,
    krav: 'proteintung, ratio ca. 3000 kcal / 200 g protein for hele retten',
  })

  const parsed = extractJsonObject<Partial<Recipe>>(await anthropic(system, user))
  if (!parsed || !parsed.title || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error('Kunne ikke tolke den genererede opskrift')
  }
  return {
    title: String(parsed.title).trim(),
    meal: parsed.meal && isMeal(String(parsed.meal)) ? (String(parsed.meal) as Meal) : meal,
    source: 'generated',
    kcal: numOrNull(parsed.kcal),
    protein_g: numOrNull(parsed.protein_g),
    total_minutes: numOrNull(parsed.total_minutes),
    servings: numOrNull(parsed.servings),
    ingredients: (parsed.ingredients as unknown[]).map(String).filter(Boolean),
    steps: (parsed.steps as unknown[]).map(String).filter(Boolean),
    tags: Array.isArray(parsed.tags) ? (parsed.tags as unknown[]).map(String).filter(Boolean) : [],
  }
}

function formatReply(r: Recipe, fresh: boolean): string {
  const lines: string[] = []
  lines.push(`🍽️ ${r.title}${fresh ? '' : ' (fra kataloget)'}`)
  const macro: string[] = []
  if (r.kcal != null) macro.push(`${r.kcal} kcal`)
  if (r.protein_g != null) macro.push(`${r.protein_g} g protein`)
  if (r.total_minutes != null) macro.push(`${r.total_minutes} min`)
  if (macro.length) lines.push(macro.join(' / '))
  lines.push('')
  lines.push('Ingredienser:')
  for (const ing of r.ingredients) lines.push(`- ${ing}`)
  lines.push('')
  lines.push('Saadan:')
  r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  return lines.join('\n')
}

// Public: suggestMeal({ meal, constraints }) -> { reply, recipe, fromCatalog }.
// Uden konkret oenske OG med noget i kataloget: genbrug mindst nyligt foreslaaet
// (variation). Med et oenske eller tomt katalog: generer en ny (constrained af
// makro-kravet + Gustavs laerte kost-fakta) og gem den tilbage i kataloget.
export async function suggestMeal(args: {
  meal?: string
  constraints?: string
}): Promise<{ reply: string; recipe: Recipe; fromCatalog: boolean }> {
  const meal = normalizeMeal(args.meal || 'aftensmad')
  const constraints = args.constraints?.trim() || undefined

  if (!constraints) {
    const fromCat = await pickFromCatalog(meal)
    if (fromCat?.id) {
      await bumpSuggested(fromCat.id)
      return { reply: formatReply(fromCat, false), recipe: fromCat, fromCatalog: true }
    }
  }

  // Laerte fakta (kost/allergi/maal m.m.) -> generatorens haarde krav.
  const factsBlock = formatGlobalForPrompt(await recallGlobal())
  const recipe = await generateRecipe(meal, constraints, factsBlock)
  const id = await saveRecipe(recipe)
  if (id) recipe.id = id
  return { reply: formatReply(recipe, true), recipe, fromCatalog: false }
}

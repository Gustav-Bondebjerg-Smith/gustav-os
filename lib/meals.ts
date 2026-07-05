// Gustav OS - mad/opskrifter (helbreds-modul, fase 1).
//
// Én verb (suggest_meal i agent-router) -> suggestMeal(): returnerer EN konkret
// opskrift, enten fra kataloget (recipes-tabellen) eller nygenereret. Genererede
// opskrifter gemmes tilbage i kataloget, saa det vokser af sig selv. Server-only,
// alt gaar via service_role (getSupabase), praecis som resten af systemet.
//
// MAKRO-KRAV (Gustavs valg) - protein foerst, saa fordeling:
// (1) RAM PROTEIN FOERST: ca. 200 g protein pr. 3000 kcal (~15 kcal/g protein,
//     protein ~27% af energien) hvis hele retten var dagens eneste mad.
// (2) Fyld DEREFTER resten af kalorierne op med kulhydrat:fedt = 4:3 (fra
//     40/30-splittet), saa fedtet aldrig forsvinder.
// (3) Overproducer IKKE protein. Ratioen er kravet, ikke et fast totaltal.
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
  carbs_g: number | null
  fat_g: number | null
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

// Normaliseret tekst (Danish-aware: aa/ae/oe) til dedup + navne-opslag i kataloget.
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/å/g, 'aa')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
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

async function anthropic(system: string, user: string, temperature = 0.6): Promise<string> {
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
      max_tokens: 1400,
      temperature,
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
    carbs_g: numOrNull(row.carbs_g),
    fat_g: numOrNull(row.fat_g),
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
        carbs_g: r.carbs_g,
        fat_g: r.fat_g,
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
    'MAKRO-KRAV (vigtigst) - foelg DENNE raekkefoelge og disse KONKRETE gram-tal. Referencedag = 3000 kcal svarer til: ~200 g protein, ~310 g kulhydrat, ~103 g fedt. (Logikken bag: protein FOERST som anker paa ~200 g, DEREFTER resten fordelt kulhydrat:fedt = 4:3.) Skaler alle TRE gram-tal samlet op/ned til din portionsstoerrelse, men HOLD forholdet imellem dem.',
    'FEDT-GULV (kritisk): fedt skal give ca. 30% af kcal, dvs. fat_g*9 skal vaere ca. 0,30*kcal. Lav ALDRIG en fedtfattig ret med masser af kulhydrat og lidt fedt - det er den hyppigste fejl. Tjek dig selv: hvis fat_g er meget under kcal/29, saa haev fedtet (mere olie/aeg/fede oste/noedder) og saenk kulhydratet tilsvarende.',
    'Overproducer IKKE protein: naar ~200 g protein pr. 3000 kcal er ramt, gaar ekstra kalorier til kulhydrat+fedt (4:3), ikke til mere protein. Ratioen er kravet, ikke et fast totaltal - lav gerne en stoerre portion (fx en HEL kylling) med flere servings og skaler alt samlet op.',
    'KONSISTENS: kcal SKAL svare til 4*protein_g + 4*carbs_g + 9*fat_g (indenfor ~5%). Regn efter foer du svarer.',
    'Humlen: naa proteinmaalet UDEN at fedtet forsvinder - brug magre proteinkilder (kylling uden skind, skyr 0,2%, hytteost, magert koed), baer kalorier paa kulhydrat (kartofler, ris, gryn), OG hold et reelt fedt-indhold (olie, aeg, fede oste/noedder i moderat maengde).',
    'Angiv kcal, protein_g, carbs_g og fat_g for HELE retten, plus servings = antal maaltider, saa baade split og pr-maaltid kan udregnes.',
    'Brug almindelige danske dagligvarer. Ingen eksotiske specialindkoeb.',
    factsBlock || '',
    factsBlock
      ? 'Respektér fakta ovenfor som HAARDE krav, isaer allergier og ting Gustav ikke spiser.'
      : '',
    'Skriv aldrig em-dashes. Brug punktum eller bindestreg.',
    'Returnér KUN ét JSON-objekt og intet andet, paa formen:',
    '{"title": str, "meal": "morgenmad|frokost|aftensmad|snack", "kcal": int (hele retten), "protein_g": int, "carbs_g": int, "fat_g": int, "total_minutes": int, "servings": int, "ingredients": [str med maengde], "steps": [str], "tags": [str]}',
  ]
    .filter(Boolean)
    .join('\n')

  const user = JSON.stringify({
    maaltid: meal,
    oenske: constraints || null,
    krav: 'referencedag 3000 kcal = ~200 g protein / ~310 g kulhydrat / ~103 g fedt (skaler samlet, hold forholdet); fedt-gulv ~30% af kcal (ingen fedtfattig-med-masser-af-kulhydrat); overproducer ikke protein; kcal = 4*P+4*C+9*F',
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
    carbs_g: numOrNull(parsed.carbs_g),
    fat_g: numOrNull(parsed.fat_g),
    total_minutes: numOrNull(parsed.total_minutes),
    servings: numOrNull(parsed.servings),
    ingredients: (parsed.ingredients as unknown[]).map(String).filter(Boolean),
    steps: (parsed.steps as unknown[]).map(String).filter(Boolean),
    tags: Array.isArray(parsed.tags) ? (parsed.tags as unknown[]).map(String).filter(Boolean) : [],
  }
}

function formatReply(r: Recipe, opts?: { tag?: string; note?: string }): string {
  const lines: string[] = []
  lines.push(`🍽️ ${r.title}${opts?.tag ? ` ${opts.tag}` : ''}`)
  const macro: string[] = []
  if (r.kcal != null) macro.push(`${r.kcal} kcal`)
  if (r.protein_g != null) macro.push(`${r.protein_g} g protein`)
  if (r.total_minutes != null) macro.push(`${r.total_minutes} min`)
  if (macro.length) lines.push(macro.join(' / '))
  if (r.carbs_g != null && r.protein_g != null && r.fat_g != null) {
    lines.push(`Makro: ${r.carbs_g} g kulhydrat / ${r.protein_g} g protein / ${r.fat_g} g fedt`)
  }
  if (r.servings && r.servings > 1 && r.kcal != null && r.protein_g != null) {
    lines.push(`ca. ${Math.round(r.kcal / r.servings)} kcal / ${Math.round(r.protein_g / r.servings)} g protein pr. maaltid (${r.servings} maaltider)`)
  }
  if (opts?.note) lines.push(opts.note)
  lines.push('')
  lines.push('Ingredienser:')
  for (const ing of r.ingredients) lines.push(`- ${ing}`)
  lines.push('')
  lines.push('Saadan:')
  r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  return lines.join('\n')
}

// Naar Gustav navngiver en konkret ret ('har du hoensesuppe-opskriften', 'den med kylling')
// matcher vi mod kataloget paa titel/tags (Danish-aware) og henter den GEMTE opskrift i stedet
// for at generere. Best-effort: fejl/intet match -> null (saa genereres der i stedet).
async function findCatalogByText(text: string): Promise<Recipe | null> {
  try {
    const qTokens = normalizeTitle(text)
      .split(' ')
      .filter((t) => t.length >= 5)
    if (!qTokens.length) return null
    const sb = getSupabase()
    const { data, error } = await sb.from('recipes').select('*')
    if (error) throw new Error(error.message)
    let best: { recipe: Recipe; score: number } | null = null
    for (const row of (data || []) as Record<string, unknown>[]) {
      const recipe = rowToRecipe(row)
      const hay = normalizeTitle(`${recipe.title} ${recipe.tags.join(' ')}`)
      const score = qTokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0)
      if (score > 0 && (!best || score > best.score)) best = { recipe, score }
    }
    return best?.recipe ?? null
  } catch (e) {
    console.error('findCatalogByText fejlede (ignoreret):', e)
    return null
  }
}

// Ord der signalerer at Gustav vil have noget NYT (spring katalog-opslag over, generer).
const NEW_INTENT = /(?<![\p{L}])(ny|nyt|nye|anderledes|overrask|noget andet)(?![\p{L}])/iu

// Signaler om at Gustav vil TILPASSE en gemt ret til sit faktiske indkoeb (skalere,
// eller ny protein-maengde/fedt%), ikke bare hente den. Danish-aware boundaries (\b
// virker ikke med ae/oe/aa). HAS_AMOUNT fanger "800 g", "1 kg", "500g".
const ADAPT_INTENT = /(?<![\p{L}])(tilpas|tilpasse|juster|justér|justere|skaler|skalér|skalere|omregn|omregne)(?![\p{L}])/iu
const HAS_AMOUNT = /\d+\s?(g|gram|kg|kilo)(?![\p{L}])/iu

// Makro-maal givet et FAST protein-tal (g). KERNEN som koden gater imod: ren formel
// udledt af reglen. 200 g protein pr. 3000 kcal = 15 kcal/g protein; resten fordelt
// kulhydrat:fedt = 4:3 efter energi -> kcal=15P, kulhydrat=11P/7 g, fedt=33P/63 g.
function macroTargets(proteinG: number): { kcal: number; carbG: number; fatG: number } {
  const P = Math.max(0, proteinG)
  return { kcal: Math.round(15 * P), carbG: Math.round((11 * P) / 7), fatG: Math.round((33 * P) / 63) }
}

function withinPct(x: number, target: number, tol: number): boolean {
  if (target <= 0) return true
  return Math.abs(x - target) <= target * tol
}

type AdaptRole = 'protein' | 'carb' | 'fat' | 'base'

interface AdaptItem {
  line: string
  role: AdaptRole
  protein_g: number
  carbs_g: number
  fat_g: number
}

const ADAPT_ROLES: AdaptRole[] = ['protein', 'carb', 'fat', 'base']
function toRole(v: unknown): AdaptRole {
  const s = String(v ?? '').toLowerCase()
  return (ADAPT_ROLES as string[]).includes(s) ? (s as AdaptRole) : 'base'
}

// Skalér maengden (foerste tal) i en ingrediens-linje. Dansk decimalkomma. Under 20
// beholdes én decimal (fx 2,5 spsk), ellers heltal.
function scaleLine(line: string, factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.02) return line
  return line.replace(/\d+(?:[.,]\d+)?/, (m) => {
    const n = parseFloat(m.replace(',', '.'))
    if (!Number.isFinite(n)) return m
    const scaled = n * factor
    const rounded = scaled >= 20 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10)
    return rounded.replace('.', ',')
  })
}

// ÉT LLM-kald: tilpas skabelonen til Gustavs indkoeb og TAG hver ingrediens' rolle
// (protein/carb/fat/base) + makroer pr. linje. LLM'en behoever ikke selv ramme reglen
// praecist - koden finjusterer bagefter. Enkelt kald = ingen loop-stoej.
async function callAdapt(
  template: Recipe,
  reality: string
): Promise<{ title?: string; servings?: number; total_minutes?: number; ingredients: AdaptItem[]; steps: string[] } | null> {
  const system = [
    "Du er Gustav OS' kok. Du faar en SKABELON-opskrift og Gustavs FAKTISKE indkoeb/oenske. Tilpas opskriften: SAMME ret og metode, men juster ingrediens-maengderne til hans virkelighed (fx anden koed-maengde/fedt%, eller flere portioner).",
    'Behold protein-kilden praecis som han angiver den (maengde + evt. fedt%).',
    'For HVER ingrediens: angiv (1) "line" = maengde + ingrediens, (2) "role" = praecis én af: "protein" (koed/fisk/aeg - protein-kilden), "carb" (ris/pasta/kartofler/broed/gryn), "fat" (ost/olie/smoer/noedder/floede), "base" (groent/tomat/loeg/krydderi/vaeske/bouillon), (3) realistiske makroer for DEN maengde (IKKE pr. 100 g): protein_g, carbs_g, fat_g.',
    'Sigt efter rimelige maengder taet paa reglen (protein ~200 g pr. 3000 kcal, kulhydrat:fedt ca. 4:3), men vaer ikke bange for at ramme lidt ved siden af - koden finjusterer kulhydrat- og fedt-maengderne bagefter.',
    'Skriv aldrig em-dashes. Returnér KUN ét JSON-objekt paa formen:',
    '{"title": str, "servings": int, "total_minutes": int, "ingredients": [{"line": str, "role": "protein|carb|fat|base", "protein_g": int, "carbs_g": int, "fat_g": int}], "steps": [str]}',
  ].join('\n')

  const user = JSON.stringify({
    skabelon: {
      title: template.title,
      servings: template.servings,
      ingredients: template.ingredients,
      steps: template.steps,
      makro_hele_retten: { kcal: template.kcal, protein_g: template.protein_g, carbs_g: template.carbs_g, fat_g: template.fat_g },
    },
    gustavs_indkoeb: reality,
  })

  const parsed = extractJsonObject<{
    title?: string
    servings?: unknown
    total_minutes?: unknown
    ingredients?: unknown[]
    steps?: unknown[]
  }>(await anthropic(system, user, 0.3))
  if (!parsed || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) return null
  const ingredients: AdaptItem[] = (parsed.ingredients as Record<string, unknown>[])
    .map((it) => ({
      line: String(it?.line ?? '').trim(),
      role: toRole(it?.role),
      protein_g: numOrNull(it?.protein_g) ?? 0,
      carbs_g: numOrNull(it?.carbs_g) ?? 0,
      fat_g: numOrNull(it?.fat_g) ?? 0,
    }))
    .filter((it) => it.line)
  if (!ingredients.length) return null
  return {
    title: parsed.title ? String(parsed.title).trim() : undefined,
    servings: numOrNull(parsed.servings) ?? undefined,
    total_minutes: numOrNull(parsed.total_minutes) ?? undefined,
    ingredients,
    steps: (parsed.steps as unknown[]).map(String).filter(Boolean),
  }
}

// Tilpas en gemt skabelon til Gustavs indkoeb. LLM tagger roller + makroer i ÉT kald;
// KODEN loeser derefter makro-reglen DETERMINISTISK: den skalerer kulhydrat-leddet og
// fedt-leddet i et fixed-point (maal fra macroTargets(protein)) indtil protein-foerst
// + 4:3 holder. Protein-leddet roeres aldrig. kcal saettes af koden (4P+4C+9F), saa
// label-drift er umulig. null ved fejl -> caller falder til den gemte ret.
async function adaptRecipe(template: Recipe, reality: string): Promise<{ recipe: Recipe; note: string; converged: boolean } | null> {
  let parsed: Awaited<ReturnType<typeof callAdapt>> = null
  try {
    parsed = await callAdapt(template, reality)
  } catch (e) {
    console.error('callAdapt fejlede:', e)
    return null
  }
  if (!parsed || !parsed.ingredients.length) return null

  const items = parsed.ingredients.map((i) => ({ ...i }))
  const sum = (arr: AdaptItem[], k: 'protein_g' | 'carbs_g' | 'fat_g') => arr.reduce((n, i) => n + (i[k] || 0), 0)
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
  const scaleRole = (role: AdaptRole, s: number) => {
    if (!Number.isFinite(s) || Math.abs(s - 1) < 0.02) return
    for (const i of items) {
      if (i.role !== role) continue
      i.protein_g *= s
      i.carbs_g *= s
      i.fat_g *= s
      i.line = scaleLine(i.line, s)
    }
  }

  // Deterministisk fixed-point (i KODE, ingen LLM): skalér kulhydrat- og fedt-leddet
  // mod maalet udledt af det aktuelle protein. Konvergerer paa faa runder (svag kobling).
  const hasCarb = items.some((i) => i.role === 'carb' && i.carbs_g > 0)
  const hasFat = items.some((i) => i.role === 'fat' && i.fat_g > 0)
  for (let k = 0; k < 8; k++) {
    let moved = 0
    if (hasCarb) {
      const P = sum(items, 'protein_g')
      const C = sum(items, 'carbs_g')
      const lever = sum(items.filter((i) => i.role === 'carb'), 'carbs_g')
      const s = clamp((macroTargets(P).carbG - (C - lever)) / lever, 0.2, 5)
      scaleRole('carb', s)
      moved = Math.max(moved, Math.abs(s - 1))
    }
    if (hasFat) {
      const P = sum(items, 'protein_g')
      const F = sum(items, 'fat_g')
      const lever = sum(items.filter((i) => i.role === 'fat'), 'fat_g')
      const s = clamp((macroTargets(P).fatG - (F - lever)) / lever, 0.2, 5)
      scaleRole('fat', s)
      moved = Math.max(moved, Math.abs(s - 1))
    }
    if (moved < 0.02) break
  }

  const P = Math.round(sum(items, 'protein_g'))
  const C = Math.round(sum(items, 'carbs_g'))
  const F = Math.round(sum(items, 'fat_g'))
  const t = macroTargets(P)
  const kcal = 4 * P + 4 * C + 9 * F
  const perServing = template.servings && template.kcal ? template.kcal / template.servings : 730
  const servings = kcal > 0 && perServing > 0 ? clamp(Math.round(kcal / perServing), 1, 12) : template.servings
  const recipe: Recipe = {
    title: (parsed.title || template.title).trim(),
    meal: template.meal,
    source: 'generated',
    kcal,
    protein_g: P,
    carbs_g: C,
    fat_g: F,
    total_minutes: parsed.total_minutes ?? template.total_minutes,
    servings,
    ingredients: items.map((i) => i.line),
    steps: parsed.steps.length ? parsed.steps : template.steps,
    tags: template.tags,
  }
  const converged = withinPct(C, t.carbG, 0.12) && withinPct(F, t.fatG, 0.12)
  const proteinPer3000 = kcal ? Math.round((P / kcal) * 3000) : 0
  const carbFat = F ? ((C * 4) / (F * 9)).toFixed(2) : 'n/a'
  // Diagnostisk note ved ikke-konvergens: sig HVAD der er galt (typisk manglende
  // lever, eller et koed saa fedt/magert at 4:3 ikke kan naas uden at aendre det).
  let diag = ''
  if (!converged) {
    const parts: string[] = []
    if (!hasCarb) parts.push('ingen kulhydrat-kilde at justere paa')
    if (!hasFat) parts.push('ingen fedt-kilde at justere paa')
    if (!withinPct(F, t.fatG, 0.12)) {
      parts.push(
        F > t.fatG
          ? `fedtet er hoejt (${F} g mod maal ${t.fatG}) - koedet/osten er fedt, draen fedt fra eller vaelg magrere`
          : `fedtet er lavt (${F} g mod maal ${t.fatG}) - der mangler fedt at skrue op paa`
      )
    }
    if (!withinPct(C, t.carbG, 0.12)) {
      parts.push(C > t.carbG ? `kulhydrat er hoejt (${C} g mod ${t.carbG})` : `kulhydrat er lavt (${C} g mod ${t.carbG})`)
    }
    diag = ` Bemaerk: ${parts.join('; ')}.`
  }
  const note = `Tilpasset fra "${template.title}". Protein ${proteinPer3000} g/3000 kcal, kulhydrat:fedt ${carbFat} (maal 1,33).${diag}`
  return { recipe, note, converged }
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

  const wantsNew = constraints ? NEW_INTENT.test(constraints) : false

  // 1) Navngiver han en konkret ret vi allerede har (og vil ikke have noget nyt)?
  if (constraints && !wantsNew) {
    const match = await findCatalogByText(constraints)
    if (match?.id) {
      // 1a) TILPAS-STI: vil han skalere/justere retten til sit faktiske indkoeb?
      //     ('tilpas den bagte ret, jeg har 800 g oksekoed 12%', 'skalér til 6').
      //     LLM foreslaar maengder, KODEN gater makroerne mod reglen.
      if (ADAPT_INTENT.test(constraints) || HAS_AMOUNT.test(constraints)) {
        const adapted = await adaptRecipe(match, constraints)
        if (adapted) {
          await bumpSuggested(match.id)
          return {
            reply: formatReply(adapted.recipe, { tag: '(tilpasset)', note: adapted.note }),
            recipe: adapted.recipe,
            fromCatalog: true,
          }
        }
      }
      // 1b) Ellers: hent den GEMTE opskrift som den er.
      await bumpSuggested(match.id)
      return { reply: formatReply(match, { tag: '(fra kataloget)' }), recipe: match, fromCatalog: true }
    }
  }

  // 2) Intet konkret oenske + noget i kataloget -> variation (mindst nyligt foreslaaet).
  if (!constraints) {
    const fromCat = await pickFromCatalog(meal)
    if (fromCat?.id) {
      await bumpSuggested(fromCat.id)
      return { reply: formatReply(fromCat, { tag: '(fra kataloget)' }), recipe: fromCat, fromCatalog: true }
    }
  }

  // 3) Ellers: generer constrained af makro + Gustavs laerte kost-fakta, og gem tilbage.
  const factsBlock = formatGlobalForPrompt(await recallGlobal())
  const recipe = await generateRecipe(meal, constraints, factsBlock)
  const id = await saveRecipe(recipe)
  if (id) recipe.id = id
  return { reply: formatReply(recipe), recipe, fromCatalog: false }
}

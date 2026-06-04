// Fælles capture-flow: gem rå tekst i raw_captures, klassificér via Haiku,
// embed via OpenAI. Bruges af Telegram-webhooken og dashboardets web-capture.
//
// Klassificering og embedding kører best-effort: hvis de fejler, gemmes
// captures stadig som rå tekst. Det stemmer overens med princippet om at
// rå capture er helligt.
import 'server-only'
import { getSupabase } from './supabase'
import { storeChunk } from './memory'
import { createTaskFromCapture, type Task } from './tasks'

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

export const VALID_AREAS = ['personlig', 'studie', 'arbejde'] as const
export type Area = (typeof VALID_AREAS)[number]

// Kilde-værdier matcher dem der gemmes i raw_captures.source. Dashboard
// er den nye web-formular i v2.4.
export type CaptureSource = 'telegram_text' | 'telegram_voice' | 'dashboard'

export type Classification = {
  area?: string
  type?: string
  summary?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function isArea(value: string | null | undefined): value is Area {
  return !!value && (VALID_AREAS as readonly string[]).includes(value)
}

export async function classify(text: string): Promise<Classification> {
  const system = [
    'Du klassificerer korte beskeder til Gustavs personlige second brain.',
    'Svar KUN med JSON, intet andet, på formen:',
    '{"area":"...","type":"...","summary":"..."}',
    '- area: præcis en af "personlig", "studie", "arbejde".',
    '- type: præcis en af "opgave", "note", "ide", "aftale".',
    '- summary: kort dansk resume, max 8 ord.',
    'Kontekst: Gustav er medicinstuderende (SDU), sygeplejevikar og forskningsassistent.',
    '"studie" = medicinstudiet. "arbejde" = vagter og forskning. "personlig" = alt andet (familie, venner, sundhed, fritid).',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  return JSON.parse(cleaned) as Classification
}

export type SaveCaptureResult = {
  id: string
  area: Area | null
  classification: Classification | null
  task?: Task | null
  classifyError?: string
  embedError?: string
  taskError?: string
}

// Gemmer en capture, klassificerer (best-effort), embedder (best-effort).
// Returnerer altid id'et hvis raw-insert lykkedes; klassificering og
// embedding logges som warnings men blokerer ikke.
export async function saveCapture(input: {
  content: string
  source: CaptureSource
}): Promise<SaveCaptureResult> {
  const content = input.content.trim()
  if (!content) throw new Error('saveCapture: tomt indhold')

  const sb = getSupabase()
  const { data, error } = await sb
    .from('raw_captures')
    .insert({ source: input.source, content })
    .select('id')
    .single()
  if (error) throw new Error(`raw_captures insert-fejl: ${error.message}`)

  const id = String(data.id)
  let classification: Classification | null = null
  let area: Area | null = null
  let classifyError: string | undefined
  let embedError: string | undefined
  let task: Task | null = null
  let taskError: string | undefined

  try {
    classification = await classify(content)
    area = isArea(classification.area) ? classification.area : null
    await sb
      .from('raw_captures')
      .update({ area, classification, processed: true })
      .eq('id', id)
  } catch (e) {
    classifyError = e instanceof Error ? e.message : String(e)
    console.error('saveCapture: klassificering fejlede (ikke kritisk):', classifyError)
  }

  // Auto-fangst: er det en opgave, oprettes den prioriteret på boardet (best-
  // effort - en fejl her må aldrig blokere selve capturen).
  if (classification?.type === 'opgave') {
    try {
      task = await createTaskFromCapture({ text: content, area, sourceCaptureId: id })
    } catch (e) {
      taskError = e instanceof Error ? e.message : String(e)
      console.error('saveCapture: opgave-oprettelse fejlede (ikke kritisk):', taskError)
    }
  }

  try {
    await storeChunk({
      content,
      source_type: 'raw_capture',
      source_id: id,
      area,
      metadata: {
        source: input.source,
        summary: classification?.summary || null,
        type: classification?.type || null,
      },
    })
  } catch (e) {
    embedError = e instanceof Error ? e.message : String(e)
    console.error('saveCapture: embed fejlede (ikke kritisk):', embedError)
  }

  return { id, area, classification, task, classifyError, embedError, taskError }
}

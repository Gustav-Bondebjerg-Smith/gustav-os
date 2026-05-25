// Klassificerer en capture-tekst med Claude Haiku. Returnerer {area, type, summary} eller kaster fejl.
// Delt modul: bruges af telegram-poll.mjs (live) og reclassify.mjs (backfill).
import './load-env.mjs'

export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001' // billig + hurtig til klassificering
export const VALID_AREAS = ['personlig', 'studie', 'arbejde']

export async function classify(text) {
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
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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
  return JSON.parse(cleaned)
}

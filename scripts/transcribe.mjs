// Transskriberer lyd til tekst med OpenAI Whisper. Returnerer teksten eller kaster fejl.
// Delt modul: bruges af telegram-poll.mjs (voicenotes).
import './load-env.mjs'

export const WHISPER_MODEL = 'whisper-1'

// bytes: ArrayBuffer eller Uint8Array. filename: navn med rigtig endelse (fx .oga) så Whisper kender formatet.
export async function transcribeAudio(bytes, filename = 'voice.oga') {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('Mangler OPENAI_API_KEY i .env.local')

  const form = new FormData()
  form.append('file', new Blob([bytes]), filename)
  form.append('model', WHISPER_MODEL)
  form.append('language', 'da') // dansk som udgangspunkt. Fjern linjen for auto-detektion.

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` }, // sæt IKKE content-type selv; FormData sætter boundary
    body: form,
  })
  if (!r.ok) throw new Error(`Whisper HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return (j.text || '').trim()
}

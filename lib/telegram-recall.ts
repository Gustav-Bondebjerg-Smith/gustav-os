// Recall/ask via second brain. Splittet ud af lib/telegram-webhook.ts (2026-07-06).
import 'server-only'
import { sendChatAction, sendMessage, type HandleResult, type TelegramMessage } from './telegram-shared'
import { ask } from './ask'
import { recallGlobal, formatGlobalForPrompt } from './memory-facts'

// Kerne-recall: slår op i second brain og svarer. Bruges af både /ask
// (tekst-kommando) og recall-kategorien i triagen (hverdagssprog + voice).
// label giver audit-reason: "ask" -> ask_answered/ask_failed, "recall" -> recall_*.
// Read-only, så ingen dobbelt-gate: triagen kan rute hertil på egen hånd.
export async function answerQuestion(
  chatId: number,
  question: string,
  label: 'ask' | 'recall'
): Promise<HandleResult> {
  await sendChatAction(chatId)
  try {
    // Lærte globale fakta sendes med, så svaret respekterer Gustavs præferencer
    // (fx "angiv ikke kilder"). Modellen ejer nu kilde-angivelsen i stedet for en
    // kode-genereret blok, så en præference faktisk kan slå den fra.
    const globalFacts = formatGlobalForPrompt(await recallGlobal())
    const { answer } = await ask(question, globalFacts)
    await sendMessage(chatId, answer)
    return { status: 'processed', reason: `${label}_answered` }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke svare lige nu: ${error}`)
    return { status: 'processed', reason: `${label}_failed` }
  }
}

export async function handleAsk(msg: TelegramMessage): Promise<HandleResult> {
  const question = (msg.text || '').replace(/^\/ask\s*/i, '').trim()
  if (!question) {
    await sendMessage(
      msg.chat.id,
      'Brug: /ask <spørgsmål>. Fx: /ask hvad var jeg ved at glemme i går?'
    )
    return { status: 'processed', reason: 'empty_ask' }
  }
  return answerQuestion(msg.chat.id, question, 'ask')
}

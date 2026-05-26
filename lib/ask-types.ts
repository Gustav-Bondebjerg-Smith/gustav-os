export type Chunk = {
  id: string
  content: string
  source_type: string
  source_id: string
  area: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  similarity: number
}

export type AskResult = {
  answer: string
  sources: Chunk[]
}

import { embed as aiEmbed, embedMany as aiEmbedMany } from 'ai'
import { embeddingModel } from './registry'

// Embedding helpers (task-graph M1). text-embedding-3-small @ 1536 via the AI SDK.
export async function embed(text: string): Promise<number[]> {
  const { embedding } = await aiEmbed({ model: embeddingModel(), value: text })
  return embedding
}

export async function embedMany(values: string[]): Promise<number[][]> {
  if (values.length === 0) return []
  const { embeddings } = await aiEmbedMany({ model: embeddingModel(), values })
  return embeddings
}

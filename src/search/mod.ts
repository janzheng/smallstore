export { extractSearchableText } from './text-extractor.ts';
export { SqliteFtsSearchProvider } from './sqlite-fts-provider.ts';
export { MemoryBm25SearchProvider } from './memory-bm25-provider.ts';
export { MemoryVectorSearchProvider, type MemoryVectorConfig } from './memory-vector-provider.ts';
export { MemoryHybridSearchProvider, type MemoryHybridConfig } from './memory-hybrid-provider.ts';
export { ZvecSearchProvider, type ZvecConfig } from './zvec-provider.ts';
export {
  createEmbed,
  createHuggingFaceEmbed,
  createOpenAIEmbed,
  type EmbedFunction,
  type BatchEmbedFunction,
  type EmbedConfig,
  type HuggingFaceEmbedConfig,
  type OpenAIEmbedConfig,
} from './embed.ts';

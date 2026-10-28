export { DEFAULT_BASE_URL, DEFAULT_MODEL, loadEmbeddingsConfig, type EmbeddingsConfig } from "./config.js";
export {
  createOpenAiProvider,
  ProviderError,
  type EmbeddingItem,
  type EmbeddingsProvider,
  type EmbedResult,
  type Usage,
} from "./provider.js";
export { createEmbeddingsService, EMBEDDINGS_PATH, type EmbeddingsServiceOptions } from "./service.js";

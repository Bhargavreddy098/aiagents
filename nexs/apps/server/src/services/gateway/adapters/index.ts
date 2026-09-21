import type { ProviderType } from '@nexs/shared';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';
import { OpenAICompatibleAdapter } from './openai.js';
import type { ProviderAdapter } from './types.js';

/**
 * Which wire protocol each provider speaks.
 *
 * Every entry here is real — a provider listed as `openai-compatible` genuinely
 * implements the OpenAI chat-completions format at the given base URL.
 *
 * `google` (Gemini) has its own adapter because its wire format (contents, parts,
 * generationConfig, functionDeclarations) is structurally different from OpenAI.
 */
export function createAdapterRegistry(): Map<ProviderType, ProviderAdapter> {
  const adapters: ProviderAdapter[] = [
    // Native json_schema decoding, and the only provider that documents
    // `stream_options.include_usage`.
    new OpenAICompatibleAdapter({
      type: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      structuredOutput: 'json_schema',
    }),
    // Azure puts the deployment in the path and authenticates with `api-key`.
    new OpenAICompatibleAdapter({
      type: 'azure-openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      structuredOutput: 'json_schema',
      azure: true,
    }),
    new OpenAICompatibleAdapter({ type: 'groq', defaultBaseUrl: 'https://api.groq.com/openai/v1' }),
    new OpenAICompatibleAdapter({ type: 'mistral', defaultBaseUrl: 'https://api.mistral.ai/v1' }),
    new OpenAICompatibleAdapter({ type: 'deepseek', defaultBaseUrl: 'https://api.deepseek.com/v1' }),
    new OpenAICompatibleAdapter({ type: 'xai', defaultBaseUrl: 'https://api.x.ai/v1' }),
    new OpenAICompatibleAdapter({ type: 'together', defaultBaseUrl: 'https://api.together.xyz/v1' }),
    new OpenAICompatibleAdapter({
      type: 'openrouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
    }),
    // Self-hosted: the operator supplies baseUrl, so there is no sensible default.
    new OpenAICompatibleAdapter({ type: 'openai-compatible', defaultBaseUrl: '' }),
    new OpenAICompatibleAdapter({ type: 'local', defaultBaseUrl: 'http://localhost:11434/v1' }),
    new OpenAICompatibleAdapter({ type: 'ollama', defaultBaseUrl: 'http://localhost:11434/v1' }),
    new AnthropicAdapter(),
    new GoogleAdapter(),
  ];

  return new Map(adapters.map((adapter) => [adapter.type, adapter]));
}

export type { ProviderAdapter } from './types.js';
export type { AdapterChatRequest, AdapterChatResult, AdapterContext, DiscoveredModel } from './types.js';
export { ProviderError } from './errors.js';
export { guessModelType } from './discovery.js';

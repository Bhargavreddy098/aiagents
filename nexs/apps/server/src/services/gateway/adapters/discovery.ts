/**
 * Shared helpers for reading a provider's model catalogue.
 *
 * Small enough to live in one file, and it does, because both adapters need the same two things:
 * a conservative type guess and a tolerant list unwrapper. Duplicating either would mean the two
 * adapters could disagree about what `type: 'embedding'` means, which is the kind of divergence
 * that only shows up as a model that is offered for chat and 400s.
 */

/**
 * Guess a model's type from its id.
 *
 * ## Why this is a guess, and why it leans the way it does
 *
 * No provider's catalogue endpoint states whether a model is for chat, embeddings or images.
 * The only evidence available is the id, and vendors do follow a convention — `text-embedding-3-small`,
 * `voyage-embed`, `nomic-embed-text`, `dall-e-3`, `gpt-image-1`.
 *
 * The convention is not a contract, so the guess is allowed to be wrong. What matters is *which
 * way* it is wrong:
 *
 *  - Guessing `chat` for something that is really an embedding model fails at call time with a
 *    capability assertion naming the model. Loud, attributable, fixable.
 *  - Guessing `embedding` for something that is really a chat model means the model is never
 *    offered to the planner at all. Silent, and indistinguishable from "the provider has no
 *    models".
 *
 * So the default is `chat`, and only an id that *says* it is something else is treated as
 * something else. `PATCH /api/models/:id` is the correction path, and it is the reason the guess
 * does not need to be clever.
 */
export function guessModelType(externalId: string): 'chat' | 'embedding' | 'image' {
  const id = externalId.toLowerCase();

  if (id.includes('embed')) return 'embedding';
  // `dall-e`, `gpt-image`, `stable-diffusion`, `flux`, `imagen` — the image families that
  // actually appear in catalogues. Kept as a literal list rather than a looser regex on purpose:
  // a substring like `image` alone would also match `image-to-text` chat models.
  if (/dall-e|gpt-image|stable-diffusion|(^|[/-])flux|imagen|sd[0-9]/.test(id)) return 'image';

  return 'chat';
}

/**
 * Unwrap whatever shape a catalogue endpoint returned.
 *
 * Three shapes are in the wild for OpenAI-compatible runtimes: `{ data: [...] }` (the documented
 * one), a bare array, and `{ models: [...] }`. Entries that are not objects are dropped rather
 * than coerced — a catalogue is external input and a `null` in the middle of it should cost that
 * one entry, not the whole sync.
 */
export function unwrapCatalogue(payload: unknown): Record<string, unknown>[] {
  const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root['data'])
      ? root['data']
      : Array.isArray(root['models'])
        ? root['models']
        : [];

  return list.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

/**
 * Read an id out of a catalogue entry, trying the field names vendors actually use.
 *
 * Returns `null` for an entry with no usable id. An entry with no id cannot be addressed on the
 * wire, so a row built from it would be a model that can never be called — worse than omitting it.
 */
export function readModelId(entry: Record<string, unknown>): string | null {
  for (const key of ['id', 'name', 'model', 'model_id']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** A display label, when the entry offers one distinct from its id. */
export function readModelLabel(entry: Record<string, unknown>): string | undefined {
  for (const key of ['display_name', 'displayName', 'title', 'label']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env";
import { cached, key, TTL } from "../cache";

/**
 * Thin wrapper over the model provider.
 *
 * The model name is never hardcoded — it comes from OPENAI_MODEL — so upgrading
 * to a newer model is a config change, not a code change. That matters more than
 * it sounds: hardcoded model strings are the most common reason an AI codebase
 * rots within a quarter.
 */
export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export const MODEL = env.OPENAI_MODEL;
export const EMBED_MODEL = env.OPENAI_EMBED_MODEL;

/**
 * Per-model request tuning.
 *
 * GPT-5 and the o-series renamed `max_tokens` to `max_completion_tokens` and
 * dropped support for any temperature other than the default. Older models
 * accept the opposite convention. Since MODEL is configurable by design, the
 * client has to speak both dialects rather than pin itself to one generation —
 * otherwise every model upgrade becomes a code change, which is exactly what
 * making the model an env var was meant to avoid.
 */
export function tuning(maxTokens: number, temperature: number) {
  const reasoningEra = /^(gpt-5|o[1-9])/.test(MODEL);
  return reasoningEra
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens, temperature };
}

export interface CompletionOpts {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

/** Non-streaming completion, used inside the map-reduce passes. */
export async function complete({ system, user, temperature = 0.2, maxTokens = 1400 }: CompletionOpts): Promise<string> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    ...tuning(maxTokens, temperature),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Structured output with schema validation and one repair attempt.
 *
 * JSON mode makes the response parseable; it does not make it *correct* against
 * your schema. The retry passes the Zod error back to the model, which fixes
 * the overwhelming majority of shape violations on the second pass.
 */
// Generic over the schema, not over T. `z.ZodType<T>` forces input and output to
// be the same type, which is wrong for any schema using .default() — there,
// `citations` is optional going in and guaranteed coming out. Parameterising on
// the schema and returning z.output<S> gives callers the post-parse type, which
// is what safeParse actually hands back.
export async function completeJson<S extends z.ZodTypeAny>(
  schema: S,
  { system, user, temperature = 0.1, maxTokens = 2600 }: CompletionOpts
): Promise<z.output<S>> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: `${system}\n\nRespond with a single JSON object and no other text.` },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await openai.chat.completions.create({
      model: MODEL,
      ...tuning(maxTokens, temperature),
      response_format: { type: "json_object" },
      messages,
    });

    const content = res.choices[0]?.message?.content ?? "{}";
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: "That was not valid JSON. Return only a valid JSON object." });
      continue;
    }

    const result = schema.safeParse(parsedJson);
    if (result.success) return result.data;

    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: `The JSON did not match the required schema. Fix these issues and return the corrected object:\n${result.error.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`,
    });
  }

  throw new Error("Model did not return schema-valid JSON after a repair attempt");
}

/** Streaming completion as an async iterable of text deltas. */
export async function* streamText({
  system,
  user,
  history = [],
  temperature = 0.3,
  maxTokens = 2000,
}: CompletionOpts & { history?: OpenAI.Chat.ChatCompletionMessageParam[] }): AsyncGenerator<string> {
  const stream = await openai.chat.completions.create({
    model: MODEL,
    ...tuning(maxTokens, temperature),
    stream: true,
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: user }],
  });

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/**
 * Batched, cached embeddings. Embedding the same headline twice is pure waste,
 * and news feeds repeat heavily across refreshes, so cache hit rates here are
 * high in practice.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results = new Array<number[] | undefined>(texts.length);
  const toFetch: { index: number; text: string }[] = [];

  await Promise.all(
    texts.map(async (text, index) => {
      const cacheKey = key("embed", { hash: hash(text), model: EMBED_MODEL });
      const hit = await cached<number[] | null>(cacheKey, TTL.embedding, async () => null);
      if (hit && hit.length) results[index] = hit;
      else toFetch.push({ index, text });
    })
  );

  // The API accepts arrays, so one call covers every miss.
  for (let i = 0; i < toFetch.length; i += 96) {
    const batch = toFetch.slice(i, i + 96);
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch.map((b) => b.text.slice(0, 8000)),
    });
    res.data.forEach((row, j) => {
      const target = batch[j];
      if (!target) return;
      results[target.index] = row.embedding;
      void cached(key("embed", { hash: hash(target.text), model: EMBED_MODEL }), TTL.embedding, async () => row.embedding);
    });
  }

  return results.map((r) => r ?? []);
}

/** FNV-1a: fast, stable, and adequate for cache keys. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

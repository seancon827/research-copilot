import { z } from "zod";

/**
 * Env is validated once at module load. Data-provider keys are *optional* on
 * purpose: the app degrades to whichever providers are configured rather than
 * refusing to boot. Missing keys surface in the UI as "not configured" instead
 * of a 500.
 */
const schema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  OPENAI_EMBED_MODEL: z.string().default("text-embedding-3-small"),

  FINNHUB_API_KEY: z.string().optional(),
  ALPHAVANTAGE_API_KEY: z.string().optional(),
  POLYGON_API_KEY: z.string().optional(),

  SEC_USER_AGENT: z.string().default("AI Research Copilot (contact@example.com)"),

  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot for the one key we genuinely cannot work without.
  throw new Error(
    "Invalid environment:\n" +
      parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
  );
}

export const env = parsed.data;

/** Which data sources are usable in this deployment. Drives UI badges. */
export const capabilities = {
  finnhub: Boolean(env.FINNHUB_API_KEY),
  alphaVantage: Boolean(env.ALPHAVANTAGE_API_KEY),
  polygon: Boolean(env.POLYGON_API_KEY),
  yahoo: true, // keyless fallback
  edgar: true, // keyless, UA-gated
  sharedCache: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
} as const;

export type Capability = keyof typeof capabilities;

import OpenAI from "openai";

export type DescriptionSuggestMode = "improve";

export type DescriptionSuggestSource = "openai" | "template";

export class DescriptionAiError extends Error {
  code: "not_configured" | "quota_exceeded" | "rate_limited" | "auth_failed" | "empty" | "validation";

  constructor(
    code: DescriptionAiError["code"],
    message: string
  ) {
    super(message);
    this.name = "DescriptionAiError";
    this.code = code;
  }
}

export interface DescriptionListingContext {
  currentDescription?: string;
}

export interface DescriptionSuggestResult {
  description: string;
  source: DescriptionSuggestSource;
  warning?: string;
  tokensUsed?: number;
}

/** Fallback when OpenAI is unavailable — returns the existing description unchanged. */
export function generateTemplateDescription(
  listing: DescriptionListingContext
): string {
  return listing.currentDescription?.trim() || "";
}

function parseOpenAiError(error: unknown): DescriptionAiError {
  if (error instanceof DescriptionAiError) return error;

  const apiError = error as { status?: number; message?: string; code?: string };
  const message = apiError.message || (error instanceof Error ? error.message : "");
  const lower = message.toLowerCase();

  if (apiError.status === 429 || lower.includes("quota") || lower.includes("billing")) {
    return new DescriptionAiError(
      "quota_exceeded",
      "OpenAI quota exceeded. Add billing/credits at platform.openai.com or use the template draft."
    );
  }

  if (apiError.status === 401 || lower.includes("incorrect api key")) {
    return new DescriptionAiError(
      "auth_failed",
      "Invalid OpenAI API key. Check OPENAI_API_KEY in your environment."
    );
  }

  if (apiError.status === 429 || lower.includes("rate limit")) {
    return new DescriptionAiError(
      "rate_limited",
      "OpenAI rate limit reached. Wait a minute and try again."
    );
  }

  return new DescriptionAiError(
    "empty",
    message || "Failed to improve description with AI"
  );
}

const DEFAULT_OUTPUT_TOKEN_CAP = 400;
const OUTPUT_TOKEN_FLOOR = 64;
const OUTPUT_TOKEN_MULTIPLIER = 1.15;

/** GPT-5 / o-series chat models use max_completion_tokens instead of max_tokens. */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(gpt-5|o[1-9]|o\d-)/i.test(model.trim());
}

function normalizeDescription(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Scale output cap to input size — rewrites stay near original length. */
function descriptionOutputTokenLimit(text: string): number {
  const fromEnv = process.env.OPENAI_DESCRIPTION_MAX_TOKENS;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const estimatedInputTokens = Math.ceil(text.length / 2.5);
  return Math.min(
    DEFAULT_OUTPUT_TOKEN_CAP,
    Math.max(OUTPUT_TOKEN_FLOOR, Math.ceil(estimatedInputTokens * OUTPUT_TOKEN_MULTIPLIER))
  );
}

function completionTokenOptions(model: string, outputLimit: number): {
  max_tokens?: number;
  max_completion_tokens?: number;
} {
  if (usesMaxCompletionTokens(model)) {
    return { max_completion_tokens: outputLimit };
  }
  return { max_tokens: outputLimit };
}

/** Reasoning / GPT-5 models often reject custom temperature. */
function completionTemperature(model: string): number | undefined {
  if (/^(gpt-5|o[1-9]|o\d-)/i.test(model.trim())) {
    return undefined;
  }
  return 0.65;
}

async function suggestWithOpenAi(
  listing: DescriptionListingContext
): Promise<{ description: string; tokensUsed: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new DescriptionAiError(
      "not_configured",
      "AI is not configured (missing OPENAI_API_KEY)"
    );
  }

  const currentDescription = normalizeDescription(listing.currentDescription || "");
  if (!currentDescription) {
    throw new DescriptionAiError(
      "validation",
      "Add a description before improving with AI"
    );
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const outputLimit = descriptionOutputTokenLimit(currentDescription);
  const client = new OpenAI({ apiKey });

  const systemPrompt =
    "Georgian property listing editor. Rewrite in Georgian only. Same facts—no new details. Remove phones, seller/agent names, contact CTAs, agency lines (e.g. ვთანამშრომლობ სააგენტოებთან). Top-seller tone, 2–4 short blocks, 2–6 emojis. No markdown/English. Output description only.";

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: currentDescription },
  ];

  try {
    const temperature = completionTemperature(model);
    const response = await client.chat.completions.create({
      model,
      ...completionTokenOptions(model, outputLimit),
      ...(temperature !== undefined ? { temperature } : {}),
      messages,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new DescriptionAiError("empty", "AI returned an empty description");
    }

    const tokensUsed = response.usage?.total_tokens ?? 0;
    return { description: text, tokensUsed };
  } catch (error) {
    const apiError = error as { status?: number; message?: string };
    const message = apiError.message || (error instanceof Error ? error.message : "");

    // Retry once if an unknown model family still rejects max_tokens.
    if (
      message.includes("max_completion_tokens") &&
      message.includes("max_tokens")
    ) {
      try {
        const temperature = completionTemperature(model);
        const response = await client.chat.completions.create({
          model,
          max_completion_tokens: outputLimit,
          ...(temperature !== undefined ? { temperature } : {}),
          messages,
        });
        const text = response.choices[0]?.message?.content?.trim();
        if (text) {
          return {
            description: text,
            tokensUsed: response.usage?.total_tokens ?? 0,
          };
        }
      } catch (retryError) {
        throw parseOpenAiError(retryError);
      }
    }

    throw parseOpenAiError(error);
  }
}

export async function suggestListingDescription(
  listing: DescriptionListingContext,
  _mode: DescriptionSuggestMode = "improve"
): Promise<DescriptionSuggestResult> {
  const useTemplateFallback = process.env.AI_DESCRIPTION_TEMPLATE_FALLBACK !== "false";

  try {
    const { description, tokensUsed } = await suggestWithOpenAi(listing);
    return { description, source: "openai", tokensUsed };
  } catch (error) {
    const parsed = parseOpenAiError(error);

    if (
      useTemplateFallback &&
      (parsed.code === "quota_exceeded" || parsed.code === "rate_limited" || parsed.code === "not_configured")
    ) {
      const description = generateTemplateDescription(listing);
      if (!description.trim()) {
        throw new DescriptionAiError(
          "validation",
          "Add a description before improving with AI"
        );
      }

      return {
        description,
        source: "template",
        warning: parsed.message,
      };
    }

    throw parsed;
  }
}

export function descriptionAiErrorStatus(code: DescriptionAiError["code"]): number {
  switch (code) {
    case "not_configured":
      return 503;
    case "quota_exceeded":
    case "rate_limited":
      return 429;
    case "auth_failed":
      return 502;
    case "validation":
      return 400;
    default:
      return 500;
  }
}

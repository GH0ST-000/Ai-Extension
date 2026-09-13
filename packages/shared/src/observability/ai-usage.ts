/**
 * Day 26 — AI model pricing metadata (operational estimates only).
 * Not billing authority. Day 27 will add cost controls.
 */

import type { AICostEstimate, AIUsage, ModelPricing } from '@project-x/types';

/** Pricing catalog version — bump when rates change. */
export const AI_MODEL_PRICING_VERSION = '2026-09-01' as const;

/**
 * Configured known model IDs only. Unknown models → cost unavailable.
 * Rates are approximate USD per 1M tokens for observability.
 */
export const DEFAULT_AI_MODEL_PRICING: ReadonlyArray<ModelPricing> = [
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputUsdPerMillionTokens: 0.15,
    outputUsdPerMillionTokens: 0.6,
    effectiveFrom: '2026-09-01',
    pricingVersion: AI_MODEL_PRICING_VERSION,
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 10,
    effectiveFrom: '2026-09-01',
    pricingVersion: AI_MODEL_PRICING_VERSION,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputUsdPerMillionTokens: 0.4,
    outputUsdPerMillionTokens: 1.6,
    effectiveFrom: '2026-09-01',
    pricingVersion: AI_MODEL_PRICING_VERSION,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1',
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 8,
    effectiveFrom: '2026-09-01',
    pricingVersion: AI_MODEL_PRICING_VERSION,
  },
];

const KNOWN_MODELS = new Set(DEFAULT_AI_MODEL_PRICING.map((p) => `${p.provider}:${p.model}`));

/** Normalize arbitrary model strings to a bounded known id or `other`. */
export function normalizeModelLabel(provider: string, model: string): string {
  const key = `${provider}:${model}`;
  if (KNOWN_MODELS.has(key)) return model;
  // Allow exact configured names even if not in default pricing.
  if (/^[a-zA-Z0-9._:-]{1,64}$/.test(model)) {
    const found = DEFAULT_AI_MODEL_PRICING.find((p) => p.model === model);
    if (found) return found.model;
  }
  return 'other';
}

export function findModelPricing(
  provider: string,
  model: string,
  catalog: ReadonlyArray<ModelPricing> = DEFAULT_AI_MODEL_PRICING,
): ModelPricing | undefined {
  return catalog.find((p) => p.provider === provider && p.model === model);
}

export function estimateAiCost(input: {
  provider: string;
  model: string;
  usage: AIUsage;
  catalog?: ReadonlyArray<ModelPricing>;
}): AICostEstimate {
  const pricing = findModelPricing(input.provider, input.model, input.catalog);
  if (!pricing) {
    return { source: 'unavailable' };
  }

  const hasUsage =
    input.usage.inputTokens != null ||
    input.usage.outputTokens != null ||
    input.usage.totalTokens != null;

  if (!hasUsage) {
    return { source: 'unavailable', pricingVersion: pricing.pricingVersion };
  }

  const inputTokens = input.usage.inputTokens ?? 0;
  const outputTokens = input.usage.outputTokens ?? 0;

  const inputCostUsd =
    pricing.inputUsdPerMillionTokens != null
      ? (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens
      : undefined;
  const outputCostUsd =
    pricing.outputUsdPerMillionTokens != null
      ? (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
      : undefined;

  const parts = [inputCostUsd, outputCostUsd].filter((n): n is number => n != null);
  const totalCostUsd = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;

  return {
    ...(inputCostUsd != null ? { inputCostUsd } : {}),
    ...(outputCostUsd != null ? { outputCostUsd } : {}),
    ...(totalCostUsd != null ? { totalCostUsd } : {}),
    pricingVersion: pricing.pricingVersion,
    source: input.usage.providerReported ? 'provider_usage' : 'estimated_usage',
  };
}

/**
 * Normalize provider SDK usage into AIUsage.
 * Does not invent tokens when usage is missing.
 */
export function normalizeProviderUsage(
  raw:
    | {
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
        promptTokens?: number | null;
        completionTokens?: number | null;
        cachedInputTokens?: number | null;
      }
    | null
    | undefined,
): AIUsage {
  if (!raw) {
    return { providerReported: false };
  }

  const inputTokens = raw.inputTokens ?? raw.promptTokens ?? undefined;
  const outputTokens = raw.outputTokens ?? raw.completionTokens ?? undefined;
  const totalTokens =
    raw.totalTokens ??
    (inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const cachedInputTokens = raw.cachedInputTokens ?? undefined;

  const hasAny =
    inputTokens != null || outputTokens != null || totalTokens != null || cachedInputTokens != null;

  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
    ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
    providerReported: hasAny,
  };
}

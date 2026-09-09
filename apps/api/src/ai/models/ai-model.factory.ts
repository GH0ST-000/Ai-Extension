import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

import type { ApiConfig } from '../../config/configuration';

@Injectable()
export class AiModelFactory {
  private readonly logger = new Logger(AiModelFactory.name);
  private readonly model: LanguageModel;
  private readonly providerName: string;
  private readonly modelName: string;

  constructor(config: ConfigService<ApiConfig, true>) {
    const ai = config.get('ai', { infer: true });

    if (ai.provider !== 'openai') {
      throw new ServiceUnavailableException(
        `Unsupported AI provider "${ai.provider}". Only "openai" is configured.`,
      );
    }

    if (!ai.openaiApiKey || ai.openaiApiKey.trim().length === 0) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is required for AI features.');
    }

    const openai = createOpenAI({
      apiKey: ai.openaiApiKey,
    });

    this.providerName = ai.provider;
    this.modelName = ai.model;
    this.model = openai(ai.model);

    this.logger.log(
      `AI model factory ready (provider=${this.providerName}, model=${this.modelName})`,
    );
  }

  getDefaultModel(): LanguageModel {
    return this.model;
  }

  getProviderName(): string {
    return this.providerName;
  }

  getModelName(): string {
    return this.modelName;
  }
}

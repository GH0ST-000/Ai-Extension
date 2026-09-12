import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReliabilityModule } from '../reliability/reliability.module';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelFactory } from './models/ai-model.factory';
import { PromptRegistry } from './prompts/prompt.registry';

@Module({
  imports: [AuthModule, SettingsModule, forwardRef(() => ReliabilityModule)],
  controllers: [AiController],
  providers: [AiService, PromptRegistry, AiModelFactory],
  exports: [AiService],
})
export class AiModule {}

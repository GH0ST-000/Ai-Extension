import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { GithubController } from './github.controller';
import { GithubWriteService } from './github-write.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [GithubController],
  providers: [GithubWriteService],
})
export class GithubModule {}

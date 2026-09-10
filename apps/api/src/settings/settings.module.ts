import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubConnectionService } from './github-connection.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, GithubConnectionService],
  exports: [SettingsService, GithubConnectionService],
})
export class SettingsModule {}

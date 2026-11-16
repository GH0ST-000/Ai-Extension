import { Module } from '@nestjs/common';

import { GithubConnectionService } from './github-connection.service';

/**
 * Personal GitHub token storage on its own, so GithubAppModule (which needs it for the PAT
 * fallback) does not have to import SettingsModule — and SettingsModule can depend on
 * GithubAppModule without a circular import.
 */
@Module({
  providers: [GithubConnectionService],
  exports: [GithubConnectionService],
})
export class GithubConnectionModule {}

import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthRequestUser) {
    return this.settingsService.getForUser(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthRequestUser, @Body() body: UpdateSettingsDto) {
    return this.settingsService.updateForUser(user.id, body);
  }
}

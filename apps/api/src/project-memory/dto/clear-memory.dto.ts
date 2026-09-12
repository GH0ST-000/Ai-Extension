import { IsBoolean, Equals } from 'class-validator';

export class ClearProjectMemoryDto {
  @IsBoolean()
  @Equals(true, { message: 'confirm must be true to clear project memory' })
  confirm!: true;
}

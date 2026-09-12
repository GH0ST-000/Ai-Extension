import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSystemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  primaryOwner?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  primaryRepository?: string;
}

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MemoryCandidateActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  candidateId!: string;
}

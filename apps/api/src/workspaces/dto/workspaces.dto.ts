import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  slug?: string;
}

export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  slug?: string;
}

export class InviteMemberDto {
  @IsEmail()
  email!: string;

  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}

/** Alias for Nest agent naming */
export class InviteWorkspaceMemberDto extends InviteMemberDto {}

export class ChangeRoleDto {
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}

export class ChangeWorkspaceMemberRoleDto extends ChangeRoleDto {}

export class TransferOwnershipDto {
  @IsString()
  @MinLength(1)
  membershipId!: string;
}

export class TransferWorkspaceOwnershipDto extends TransferOwnershipDto {}

export class CreateCheckoutDto {
  @IsIn(['pro', 'team'])
  planId!: 'pro' | 'team';

  @IsIn(['monthly', 'yearly'])
  billingCycle!: 'monthly' | 'yearly';
}

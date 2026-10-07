import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class IdentityPlatformDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  idToken: string;
}

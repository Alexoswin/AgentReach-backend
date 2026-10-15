import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CognitoSignInDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  idToken: string;

  // The nonce the browser sent to Cognito, checked against the token.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nonce?: string;
}

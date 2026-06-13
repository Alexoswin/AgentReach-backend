import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'oswinalex1@gmail.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'DBIT@2026' })
  @IsString()
  password: string;
}

import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Oswin Alex' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'abc@gmail.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'xxxxxxxxx' })
  @IsString()
  @MinLength(8)
  password: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDomainDto {
  @ApiProperty({ example: 'example.com' })
  @IsString()
  @MaxLength(253)
  domain!: string;

  @ApiProperty({ required: false, example: 'hello@example.com' })
  @IsEmail()
  @IsOptional()
  defaultSenderEmail?: string;
}

export class UpdateDomainDto {
  @ApiProperty({ required: false, example: 'hello@example.com' })
  @IsEmail()
  @IsOptional()
  defaultSenderEmail?: string;
}

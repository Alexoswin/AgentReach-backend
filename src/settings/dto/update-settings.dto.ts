import { IsString, IsOptional, IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSettingsDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  awsAccessKeyId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  awsSecretAccessKey?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  awsRegion?: string;

  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  awsSenderEmail?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  openRouterApiKey?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  openRouterModel?: string;
}

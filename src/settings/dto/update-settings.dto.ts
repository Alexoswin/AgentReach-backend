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
  geminiApiKey?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  geminiTextModel?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  twilioAccountSid?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  twilioAuthToken?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  twilioPhoneNumber?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  twilioStatus?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  geminiStatus?: string;
}

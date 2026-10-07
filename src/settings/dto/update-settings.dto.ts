import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Every field is optional and may be an empty string (which clears it); the
// Settings page sends all fields on each save. Connection statuses are not
// accepted here: only the Test endpoints set them.
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

  // Format is checked in SettingsService only when non-empty: @IsOptional
  // does not skip '', so @IsEmail here rejected every save that left the
  // sender blank.
  @ApiProperty({ required: false })
  @IsString()
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

  @ApiProperty({ required: false, enum: ['twilio', 'plivo'] })
  @IsIn(['twilio', 'plivo'])
  @IsOptional()
  callProvider?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  plivoAuthId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  plivoAuthToken?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  plivoPhoneNumber?: string;
}

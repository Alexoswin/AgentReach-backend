import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GEMINI_TEXT_MODEL_OPTIONS } from '../../config/gemini-text';

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

  // Both reply tracking fields are format-checked in SettingsService, for
  // the same empty-string reason as awsSenderEmail.
  @ApiProperty({ required: false, example: 'reply.example.com' })
  @IsString()
  @IsOptional()
  replyTrackingDomain?: string;

  @ApiProperty({
    required: false,
    example: 'arn:aws:sns:us-east-1:123456789012:campaign-replies',
  })
  @IsString()
  @IsOptional()
  replyTrackingTopicArn?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  geminiApiKey?: string;

  @ApiProperty({ required: false })
  @IsIn(['', ...GEMINI_TEXT_MODEL_OPTIONS.map((option) => option.value)])
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

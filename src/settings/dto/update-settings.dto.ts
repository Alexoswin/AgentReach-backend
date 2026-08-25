import {
  IsString,
  IsOptional,
  IsEmail,
  IsBoolean,
  IsNumber,
  IsIn,
  IsArray,
  Min,
  Max,
} from 'class-validator';
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

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  plivoStatus?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  geminiStatus?: string;

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: Groww Trading API                                     */
  /* ------------------------------------------------------------------ */

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  growwApiKey?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  growwApiSecret?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  growwTotpSecret?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  growwStatus?: string;

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: Gemini models                                         */
  /* ------------------------------------------------------------------ */

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  tradeMasterModel?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  tradeWorkerModel?: string;

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: execution policy                                      */
  /* ------------------------------------------------------------------ */

  @ApiProperty({ required: false, enum: ['paper', 'approval', 'auto'] })
  @IsIn(['paper', 'approval', 'auto'])
  @IsOptional()
  tradeExecutionMode?: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  tradeKillSwitch?: boolean;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  tradeMaxOrderValue?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  tradeMaxDailyLoss?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  tradeMaxOpenPositions?: number;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tradeAllowedSegments?: string[];

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  tradeAllowNakedOptions?: boolean;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  tradeMarginBuffer?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  tradeMaxTokensPerRun?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  tradeMaxTokensPerDay?: number;
}

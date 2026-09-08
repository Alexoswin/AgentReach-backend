import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GeminiLiveModel } from '../../config/gemini-live';

export class CreateCallingCampaignDto {
  @ApiProperty({ example: 'AI Recruiter Initial Screen' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  objective?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiProperty({ required: false, example: 'hd' })
  @IsString()
  @IsOptional()
  voiceQuality?: string;

  @ApiProperty({ required: false, example: 'google:en-IN-Chirp3-HD-Puck' })
  @IsString()
  @IsOptional()
  voice?: string;

  @ApiProperty({ required: false, example: 'en-IN' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiProperty({ required: false, example: 'en-IN' })
  @IsString()
  @IsOptional()
  selectedLanguage?: string;

  @ApiProperty({ required: false, example: 'google:en-IN-Chirp3-HD-Puck' })
  @IsString()
  @IsOptional()
  selectedVoice?: string;

  @ApiProperty({ required: false, example: 'ai-calling-bot-id' })
  @IsString()
  @IsOptional()
  aiCallingBotId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botName?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botRole?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botGoal?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botPersonality?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botKnowledge?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botRules?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botObjectionHandling?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  botGreeting?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  contactIds?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  concurrencyLimit?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  scheduleType?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  scheduledAt?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  estimatedCost?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  estimatedDuration?: number;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  aiSpeaksFirst?: boolean;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  preventInterruption?: boolean;

  @ApiProperty({
    required: false,
    enum: GeminiLiveModel,
    example: GeminiLiveModel.FlashLivePreview,
  })
  @IsEnum(GeminiLiveModel)
  @IsOptional()
  realtimeModel?: GeminiLiveModel;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  maxTokens?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  threshold?: number;

  @ApiProperty({
    required: false,
    enum: ['fast', 'balanced', 'conservative'],
    default: 'fast',
  })
  @IsString()
  @IsIn(['fast', 'balanced', 'conservative'])
  @IsOptional()
  responseSpeed?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];
}

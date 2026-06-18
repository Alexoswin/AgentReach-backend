import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCallingCampaignDto {
  @ApiProperty({ example: 'AI Recruiter Initial Screen' })
  @IsString()
  name: string;

  @ApiProperty({
    required: false,
    example: 'Screen candidates for Software Engineering position',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    required: false,
    example: 'Evaluate candidate fit and scheduling next steps',
  })
  @IsString()
  @IsOptional()
  objective?: string;

  @ApiProperty({
    required: false,
    example: 'You are Sarah, a recruiter for TechCorp. Be friendly...',
  })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiProperty({ required: false, example: 'sarah-female-us' })
  @IsString()
  @IsOptional()
  voice?: string;

  @ApiProperty({ required: false, example: 'English' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  contactIds?: string[];

  @ApiProperty({ required: false, type: [String], example: ['sales', 'lead-gen'] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiProperty({ required: false, example: 50 })
  @IsOptional()
  concurrencyLimit?: number;

  @ApiProperty({ required: false, example: 'IMMEDIATE' })
  @IsString()
  @IsOptional()
  scheduleType?: string;

  @ApiProperty({ required: false, example: '2026-06-25T10:00:00Z' })
  @IsString()
  @IsOptional()
  scheduledAt?: string;

  @ApiProperty({ required: false, example: 'UTC' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ required: false, example: 0.15 })
  @IsOptional()
  estimatedCost?: number;

  @ApiProperty({ required: false, example: 120 })
  @IsOptional()
  estimatedDuration?: number;
}

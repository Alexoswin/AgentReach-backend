import { IsString, IsOptional, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCallingCampaignDto {
  @ApiProperty({ example: 'AI Recruiter Initial Screen' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, example: 'Screen candidates for Software Engineering position' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false, example: 'Evaluate candidate fit and scheduling next steps' })
  @IsString()
  @IsOptional()
  objective?: string;

  @ApiProperty({ required: false, example: 'You are Sarah, a recruiter for TechCorp. Be friendly...' })
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
  @IsUUID('4', { each: true })
  @IsOptional()
  contactIds?: string[];
}

import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateCallingCampaignDto {
  @ApiProperty({
    example: 'Create a warm follow-up call for SaaS leads who booked a demo.',
  })
  @IsString()
  prompt: string;

  @ApiProperty({ required: false, example: 'Warm, natural, concise' })
  @IsString()
  @IsOptional()
  tone?: string;
}

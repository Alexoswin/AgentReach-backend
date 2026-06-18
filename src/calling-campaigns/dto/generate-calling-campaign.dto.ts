import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateCallingCampaignDto {
  @ApiProperty({
    example:
      'Create a warm AI call campaign for SaaS leads who requested a demo. Qualify pain points and book a meeting.',
  })
  @IsString()
  prompt: string;

  @ApiProperty({ required: false, example: 'Friendly and consultative' })
  @IsString()
  @IsOptional()
  tone?: string;
}

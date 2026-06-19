import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAiCallingBotDto {
  @ApiProperty({ example: 'Reach Agent Calling Bot' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, example: 'Outbound AI calling bot' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ required: false, example: 'en-IN' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiProperty({ required: false, example: 'google:en-IN-Chirp3-HD-Puck' })
  @IsString()
  @IsOptional()
  voice?: string;

  @ApiProperty({ required: false, example: 'calling specialist' })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiProperty({
    required: false,
    example: 'Warm, concise, calm, and naturally conversational',
  })
  @IsString()
  @IsOptional()
  personality?: string;

  @ApiProperty({
    required: false,
    example: 'Offer details, target customer, qualification points',
  })
  @IsString()
  @IsOptional()
  knowledge?: string;

  @ApiProperty({ required: false, example: 'Ask one question at a time.' })
  @IsString()
  @IsOptional()
  rules?: string;

  @ApiProperty({
    required: false,
    example: 'If they are busy, ask for a better callback time.',
  })
  @IsString()
  @IsOptional()
  objectionHandling?: string;

  @ApiProperty({
    required: false,
    example: 'Hi {{firstName}}, this is {{botName}} from ReachConvert.',
  })
  @IsString()
  @IsOptional()
  greeting?: string;

  @ApiProperty({ required: false, example: true })
  @IsBoolean()
  @IsOptional()
  ragEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

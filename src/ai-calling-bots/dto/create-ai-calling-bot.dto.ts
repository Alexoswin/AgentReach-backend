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
    example: 'Understand customer need and capture a clear next step.',
  })
  @IsString()
  @IsOptional()
  goal?: string;

  @ApiProperty({
    required: false,
    example: 'Warm, concise, calm, and naturally conversational',
  })
  @IsString()
  @IsOptional()
  personality?: string;

  @ApiProperty({
    required: false,
    example: 'Qualify user fit and drive a clean next step.',
  })
  @IsString()
  @IsOptional()
  botObjective?: string;

  @ApiProperty({
    required: false,
    example: 'Collect core qualification and secure follow-up.',
  })
  @IsString()
  @IsOptional()
  botGoal?: string;

  @ApiProperty({
    required: false,
    example: 'Greet -> qualify -> answer -> confirm next step -> close.',
  })
  @IsString()
  @IsOptional()
  botFlow?: string;

  @ApiProperty({
    required: false,
    example: 'Product details and qualification criteria.',
  })
  @IsString()
  @IsOptional()
  knowledgeBaseText?: string;

  @ApiProperty({ required: false, example: false })
  @IsBoolean()
  @IsOptional()
  contextOutsideKnowledgeBase?: boolean;

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

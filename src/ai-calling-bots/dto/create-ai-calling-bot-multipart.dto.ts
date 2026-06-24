import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateAiCallingBotMultipartDto {
  @ApiProperty({ example: 'Reach Agent Calling Bot' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, example: 'Outbound AI calling bot' })
  @IsString()
  @IsOptional()
  description?: string;

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

  @ApiProperty({ required: false, example: 'false' })
  @IsOptional()
  @IsString()
  contextOutsideKnowledgeBase?: string;

  @ApiProperty({ required: false, example: 'true' })
  @IsOptional()
  @IsString()
  ragEnabled?: string;
}

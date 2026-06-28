import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateBotDto {
  @ApiProperty({ example: 'Reach Agent Calling Bot' })
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  voice?: string;

  @IsString()
  @IsOptional()
  role?: string;

  @IsString()
  @IsOptional()
  goal?: string;

  @IsString()
  @IsOptional()
  personality?: string;

  @IsString()
  @IsOptional()
  botObjective?: string;

  @IsString()
  @IsOptional()
  botGoal?: string;

  @IsString()
  @IsOptional()
  botFlow?: string;

  @IsString()
  @IsOptional()
  knowledgeBaseText?: string;

  @IsString()
  @IsOptional()
  knowledge?: string;

  @IsString()
  @IsOptional()
  rules?: string;

  @IsString()
  @IsOptional()
  objectionHandling?: string;

  @IsString()
  @IsOptional()
  greeting?: string;

  @IsOptional()
  contextOutsideKnowledgeBase?: boolean | string;

  @IsOptional()
  ragEnabled?: boolean | string;
}

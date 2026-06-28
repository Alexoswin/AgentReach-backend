import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class ChatBotDto {
  @ApiProperty({ example: 'Can you summarize the offer?' })
  @IsString()
  message: string;

  @IsNumber()
  @IsOptional()
  topK?: number;

  @IsString()
  @IsOptional()
  history?: string;
}


import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SearchBotDto {
  @ApiProperty({ example: 'What should the agent say about pricing?' })
  @IsString()
  query: string;

  @IsNumber()
  @IsOptional()
  topK?: number;
}


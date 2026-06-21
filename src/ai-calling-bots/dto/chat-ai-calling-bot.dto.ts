import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ChatAiCallingBotDto {
  @ApiProperty({ example: 'Can you explain the top variant features?' })
  @IsString()
  message: string;

  @ApiProperty({ required: false, example: 4, minimum: 1, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  topK?: number;
}


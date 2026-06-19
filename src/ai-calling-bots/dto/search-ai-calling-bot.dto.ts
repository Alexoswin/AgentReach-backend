import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchAiCallingBotDto {
  @ApiProperty({ example: 'What should the bot say when pricing is asked?' })
  @IsString()
  query: string;

  @ApiProperty({ required: false, example: 4 })
  @IsNumber()
  @IsOptional()
  topK?: number;
}

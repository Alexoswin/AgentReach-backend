import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TrainAiCallingBotDto {
  @ApiProperty({
    example:
      'ReachConvert helps teams run outbound email and AI calling campaigns...',
  })
  @IsString()
  content: string;

  @ApiProperty({ required: false, example: 'product-overview' })
  @IsString()
  @IsOptional()
  sourceName?: string;

  @ApiProperty({ required: false, example: true })
  @IsBoolean()
  @IsOptional()
  replace?: boolean;

  @ApiProperty({ required: false, example: 900 })
  @IsNumber()
  @IsOptional()
  chunkSize?: number;

  @ApiProperty({ required: false, example: 120 })
  @IsNumber()
  @IsOptional()
  chunkOverlap?: number;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

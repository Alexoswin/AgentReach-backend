import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TrainAiCallingBotPdfDto {
  @ApiProperty({ required: false, example: 'product-playbook.pdf' })
  @IsString()
  @IsOptional()
  sourceName?: string;

  @ApiProperty({ required: false, example: 'true' })
  @IsString()
  @IsOptional()
  replace?: string;

  @ApiProperty({ required: false, example: '900' })
  @IsString()
  @IsOptional()
  chunkSize?: string;

  @ApiProperty({ required: false, example: '120' })
  @IsString()
  @IsOptional()
  chunkOverlap?: string;
}

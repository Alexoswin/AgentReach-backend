import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SIGNAL_TYPES } from '../signal.types';

export class CreateManualSignalDto {
  @ApiProperty({ example: 'Acme raised a $12M Series A' })
  @IsString()
  title: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  summary?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiProperty({ required: false, example: 'acme.com' })
  @IsOptional()
  @IsString()
  companyDomain?: string;

  @ApiProperty({
    required: false,
    description: 'Match against a single contact email',
  })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiProperty({ required: false, enum: SIGNAL_TYPES })
  @IsOptional()
  @IsIn(SIGNAL_TYPES)
  type?: string;
}

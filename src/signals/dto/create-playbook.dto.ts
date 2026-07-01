import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SIGNAL_TYPES } from '../signal.types';

export class CreatePlaybookDto {
  @ApiProperty({ example: 'Funding congrats — SaaS founders' })
  @IsString()
  name: string;

  @ApiProperty({ example: ['funding', 'hiring-surge'] })
  @IsArray()
  @IsIn(SIGNAL_TYPES, { each: true })
  signalTypes: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  directoryIds?: string[];

  @ApiProperty()
  @IsString()
  templateId: string;

  @ApiProperty({ enum: ['auto', 'review'], default: 'review' })
  @IsIn(['auto', 'review'])
  mode: string;

  @ApiProperty({ required: false, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  cooldownDays?: number;

  @ApiProperty({ required: false, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  dailyCap?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

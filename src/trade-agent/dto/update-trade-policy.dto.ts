import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EXECUTION_MODES } from '../trade-agent.types';

export class UpdateTradePolicyDto {
  @ApiProperty({ required: false, enum: EXECUTION_MODES })
  @IsIn([...EXECUTION_MODES])
  @IsOptional()
  mode?: 'paper' | 'approval' | 'auto';

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  killSwitch?: boolean;

  @ApiProperty({ required: false, description: 'Why the switch was flipped.' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxOrderValue?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxDailyLoss?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxOpenPositions?: number;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedSegments?: string[];

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  allowNakedOptions?: boolean;

  @ApiProperty({
    required: false,
    description: 'Fraction of margin held back, 0-1.',
  })
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  marginBuffer?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxTokensPerRun?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxTokensPerDay?: number;
}

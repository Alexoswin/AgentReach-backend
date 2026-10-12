import {
  IsString,
  IsUUID,
  IsOptional,
  IsIn,
  IsEmail,
  IsArray,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;

export class UpdateCampaignDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  templateId?: string;

  @ApiProperty({ required: false, enum: CAMPAIGN_STATUSES })
  @IsIn(CAMPAIGN_STATUSES)
  @IsOptional()
  status?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  cc?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  bcc?: string[];

  @ApiProperty({
    required: false,
    description:
      'Add a tracking image to HTML emails so opens are counted (default true)',
  })
  @IsBoolean()
  @IsOptional()
  trackOpens?: boolean;
}

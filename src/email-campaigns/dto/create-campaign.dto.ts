import {
  IsString,
  IsUUID,
  IsOptional,
  IsEmail,
  IsArray,
  IsBoolean,
  IsInt,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCampaignDto {
  @ApiProperty({ example: 'Q2 Recruiter Outreach Campaign' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  templateId?: string;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['hiring-manager@company.com'],
    description: "Email addresses CC'd on every send in this campaign",
  })
  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  cc?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    example: ['records@company.com'],
    description: "Email addresses BCC'd on every send in this campaign",
  })
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

  // Format is checked in the service, so an empty string can clear it.
  @ApiProperty({
    required: false,
    description: 'Send from this verified address instead of the Sender Email',
  })
  @IsString()
  @IsOptional()
  @MaxLength(320)
  fromEmail?: string;

  @ApiProperty({ required: false, description: 'Display name on the emails' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  fromName?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Spread the sends out to this many per hour; null for no limit',
  })
  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  sendRatePerHour?: number | null;

  @ApiProperty({
    required: false,
    description:
      'Add an unsubscribe link and one-click unsubscribe headers (default true)',
  })
  @IsBoolean()
  @IsOptional()
  unsubscribeLink?: boolean;
}

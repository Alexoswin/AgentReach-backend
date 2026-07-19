import { IsString, IsUUID, IsOptional, IsEmail, IsArray } from 'class-validator';
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
    description: 'Email addresses CC\'d on every send in this campaign',
  })
  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  cc?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    example: ['records@company.com'],
    description: 'Email addresses BCC\'d on every send in this campaign',
  })
  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  bcc?: string[];
}

import { IsString, IsUUID, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCampaignDto {
  @ApiProperty({ example: 'Q2 Recruiter Outreach Campaign' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsUUID()
  @IsOptional()
  templateId?: string;
}

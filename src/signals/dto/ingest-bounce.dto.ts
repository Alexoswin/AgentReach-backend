import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class IngestBounceDto {
  @ApiProperty({ example: 'jane@acme.com' })
  @IsString()
  email: string;

  @ApiProperty({ example: 'Recipient no longer with the company' })
  @IsString()
  bounceMessage: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  companyDomain?: string;
}

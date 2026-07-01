import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWatchDto {
  @ApiProperty({ example: 'Acme Inc' })
  @IsString()
  companyName: string;

  @ApiProperty({ example: 'acme.com' })
  @IsString()
  domain: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  sourcesEnabled?: string[];
}

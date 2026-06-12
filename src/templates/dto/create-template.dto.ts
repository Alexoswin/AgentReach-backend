import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTemplateDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  subject: string;

  @ApiProperty()
  @IsString()
  bodyHtml: string;

  @ApiProperty()
  @IsString()
  bodyText: string;

  @ApiProperty({ enum: ['AI', 'PREDEFINED', 'CUSTOM'] })
  @IsString()
  @IsIn(['AI', 'PREDEFINED', 'CUSTOM'])
  type: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  goal?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  audience?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  tone?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  instructions?: string;
}

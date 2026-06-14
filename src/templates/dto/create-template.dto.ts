import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class TemplateAttachmentDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  contentType: string;

  @ApiProperty()
  @IsNumber()
  size: number;

  @ApiProperty()
  @IsString()
  contentBase64: string;
}

export class CreateTemplateDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  subject: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  bodyHtml?: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  bodyText?: string;

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

  @ApiProperty({ required: false, type: [TemplateAttachmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateAttachmentDto)
  @IsOptional()
  attachments?: TemplateAttachmentDto[];
}

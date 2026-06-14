import { IsArray, IsObject, IsString, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImportContactsDto {
  @ApiProperty({ type: [Object] })
  @IsArray()
  rows: Record<string, any>[];

  @ApiProperty({ type: Object })
  @IsObject()
  mapping: Record<string, string>; // maps standard fields (firstName, lastName, etc.) to file columns

  @ApiProperty({ enum: ['SKIP', 'OVERWRITE'], default: 'SKIP' })
  @IsString()
  @IsIn(['SKIP', 'OVERWRITE'])
  @IsOptional()
  duplicateStrategy?: 'SKIP' | 'OVERWRITE';

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  directoryId?: string;
}

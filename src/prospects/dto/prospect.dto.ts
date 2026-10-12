import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MAX_COMPANIES_PER_SEARCH,
  MAX_PEOPLE_PER_COMPANY,
} from '../prospect.constants';

export class BuildProfileDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  description: string;

  @ApiProperty({ required: false, type: [String] })
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  exampleDomains?: string[];

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @Max(MAX_COMPANIES_PER_SEARCH)
  @IsOptional()
  maxCompanies?: number;
}

export class CreateProspectSearchDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  description: string;

  @ApiProperty({ type: Object })
  @IsObject()
  profile: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @Max(MAX_COMPANIES_PER_SEARCH)
  @IsOptional()
  maxCompanies?: number;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @Max(MAX_PEOPLE_PER_COMPANY)
  @IsOptional()
  peoplePerCompany?: number;
}

export class UpdateProspectDto {
  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ required: false, enum: ['dismissed', 'restore'] })
  @IsIn(['dismissed', 'restore'])
  @IsOptional()
  action?: 'dismissed' | 'restore';
}

export class AddProspectsToContactsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids: string[];

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  directoryId?: string;

  @ApiProperty({ enum: ['SKIP', 'OVERWRITE'], default: 'SKIP' })
  @IsIn(['SKIP', 'OVERWRITE'])
  @IsOptional()
  duplicateStrategy?: 'SKIP' | 'OVERWRITE';
}

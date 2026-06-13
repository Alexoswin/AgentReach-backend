import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateTemplateDto {
  @ApiProperty({ example: 'Reach out to hiring managers for software engineering roles' })
  @IsString()
  goal: string;

  @ApiProperty({ example: 'Engineering Managers in tech startups' })
  @IsString()
  audience: string;

  @ApiProperty({ example: 'Professional and brief' })
  @IsString()
  tone: string;

  @ApiProperty({ required: false, example: 'Mention my 5 years experience with Node.js and React' })
  @IsString()
  @IsOptional()
  instructions?: string;

  @ApiProperty({ required: false, enum: ['HTML', 'TEXT'], default: 'HTML' })
  @IsString()
  @IsOptional()
  @IsIn(['HTML', 'TEXT'])
  format?: 'HTML' | 'TEXT';
}

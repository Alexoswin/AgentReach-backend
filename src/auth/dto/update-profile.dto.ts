import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const THEME_VALUES = [
  'system',
  'dark-midnight',
  'dark-slate',
  'dark-graphite',
  'dark-violet',
  'light-cloud',
  'light-paper',
  'light-mint',
  'light-rose',
] as const;

const ACCENT_VALUES = [
  'indigo',
  'emerald',
  'sky',
  'rose',
  'amber',
  'violet',
] as const;

export class UpdateProfileDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  initials?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  company?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ required: false, enum: THEME_VALUES })
  @IsString()
  @IsOptional()
  @IsIn(THEME_VALUES)
  theme?: (typeof THEME_VALUES)[number];

  @ApiProperty({ required: false, enum: ACCENT_VALUES })
  @IsString()
  @IsOptional()
  @IsIn(ACCENT_VALUES)
  accentColor?: (typeof ACCENT_VALUES)[number];

  @ApiProperty({ required: false, minLength: 8 })
  @IsString()
  @MinLength(8)
  @IsOptional()
  password?: string;

  // Required to change the password or the sign-in email.
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  currentPassword?: string;
}

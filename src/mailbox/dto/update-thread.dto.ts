import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdateThreadDto {
  @IsOptional()
  @IsBoolean()
  read?: boolean;

  @IsOptional()
  @IsBoolean()
  starred?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsBoolean()
  trashed?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  labels?: string[];
}

export const BULK_THREAD_ACTIONS = [
  'read',
  'unread',
  'star',
  'unstar',
  'archive',
  'unarchive',
  'trash',
  'untrash',
  'delete',
] as const;

export class BulkThreadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  ids: string[];

  @IsIn(BULK_THREAD_ACTIONS)
  action: (typeof BULK_THREAD_ACTIONS)[number];
}

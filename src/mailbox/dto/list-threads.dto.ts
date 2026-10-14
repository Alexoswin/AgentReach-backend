import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';
import { MAIL_FOLDERS } from '../mail-folders';
import type { MailFolder } from '../mail-folders';

export class ListThreadsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(MAIL_FOLDERS)
  folder?: MailFolder;

  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: string;

  @IsOptional()
  @IsUUID()
  campaignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;
}

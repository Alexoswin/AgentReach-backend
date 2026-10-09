import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';

export class ListContactsQueryDto extends PaginationQueryDto {
  /** A directory id, or 'uncategorized' for contacts with no directory. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  directoryId?: string;
}

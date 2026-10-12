import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';

/** Query params for the Replies inbox. */
export class ListRepliesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  campaignId?: string;

  // Query strings carry text, so "true" rather than a boolean.
  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: string;
}

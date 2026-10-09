import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from './pagination';

/** Query params for the email and calling campaign list endpoints. */
export class ListCampaignsQueryDto extends PaginationQueryDto {
  // Free-form: email and calling campaigns use different status vocabularies.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;
}

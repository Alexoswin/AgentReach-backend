import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Query params shared by every paginated list endpoint. */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/**
 * List endpoints stay backwards compatible: callers that send neither `page`
 * nor `limit` still get the full array, so screens that need every record
 * (pickers, the scheduler) keep working. Paginated callers get an envelope.
 */
export function isPaginated(query?: PaginationQueryDto) {
  return query?.page !== undefined || query?.limit !== undefined;
}

export function resolvePage(query: PaginationQueryDto = {}) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, limit, skip: (page - 1) * limit };
}

export function buildPage<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): Paginated<T> {
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Case-insensitive "contains" matcher with regex metacharacters escaped. */
export function containsRegex(term: string) {
  return {
    $regex: term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    $options: 'i',
  };
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class DraftAttachmentDto {
  @IsUUID()
  fileId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

// Addresses are checked when the draft is sent, not on every autosave, so a
// half-typed address does not block saving.
export class UpdateDraftDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  to?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  bcc?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(998)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  html?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  from?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DraftAttachmentDto)
  attachments?: DraftAttachmentDto[];

  @IsOptional()
  @IsBoolean()
  trackOpens?: boolean;
}

export class CreateDraftDto extends UpdateDraftDto {
  @IsOptional()
  @IsIn(['new', 'reply', 'replyAll', 'forward'])
  mode?: 'new' | 'reply' | 'replyAll' | 'forward';

  // The message being replied to or forwarded.
  @IsOptional()
  @IsUUID()
  sourceMessageId?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;
}

export class SendDraftDto {
  // Schedules the send; without it the email goes after the undo delay.
  @IsOptional()
  @IsISO8601()
  sendAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  undoSeconds?: number;
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { MailboxService } from './mailbox.service';
import { MailAttachmentsService } from './mail-attachments.service';
import { ListThreadsQueryDto } from './dto/list-threads.dto';
import { BulkThreadsDto, UpdateThreadDto } from './dto/update-thread.dto';
import { CreateDraftDto, SendDraftDto, UpdateDraftDto } from './dto/draft.dto';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Only these are ever shown inline; anything else (HTML, SVG, PDF, ...) is a
// download, so an attachment can never run script on this origin.
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const body = new ValidationPipe({ whitelist: true, transform: true });

@ApiTags('mail')
@Controller('mail')
export class MailboxController {
  constructor(
    private readonly mailbox: MailboxService,
    private readonly attachments: MailAttachmentsService,
  ) {}

  @Get('threads')
  @ApiOperation({
    summary: 'Conversations in a folder, newest first (paginated)',
  })
  listThreads(@Req() request: any, @Query(body) query: ListThreadsQueryDto) {
    return this.mailbox.listThreads(request.user.id, query);
  }

  @Get('counts')
  @ApiOperation({ summary: 'Unread and pending counts for the folder list' })
  counts(@Req() request: any) {
    return this.mailbox.counts(request.user.id);
  }

  @Get('senders')
  @ApiOperation({ summary: 'From addresses this account may send as' })
  senders(@Req() request: any) {
    return this.mailbox.senderOptions(request.user.id);
  }

  @Get('contact-context')
  @ApiOperation({
    summary: 'A contact with their campaigns and calls, by email',
  })
  contactContext(@Req() request: any, @Query('email') email: string) {
    return this.mailbox.contactContext(request.user.id, String(email || ''));
  }

  // Declared before ':id' so "bulk" is not read as a thread id.
  @Post('threads/bulk')
  @ApiOperation({ summary: 'Apply one action to several conversations' })
  bulk(@Req() request: any, @Body(body) dto: BulkThreadsDto) {
    return this.mailbox.bulkUpdate(request.user.id, dto);
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'A conversation with its messages and drafts' })
  getThread(@Req() request: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.mailbox.getThread(request.user.id, id);
  }

  @Patch('threads/:id')
  @ApiOperation({ summary: 'Mark read/unread, star, archive or trash' })
  updateThread(
    @Req() request: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body) dto: UpdateThreadDto,
  ) {
    return this.mailbox.updateThread(request.user.id, id, dto);
  }

  @Delete('threads/:id')
  @ApiOperation({ summary: 'Delete a trashed conversation for good' })
  deleteThread(@Req() request: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.mailbox.deleteThread(request.user.id, id);
  }

  @Post('drafts')
  @ApiOperation({ summary: 'Start a new email, reply, reply-all or forward' })
  createDraft(@Req() request: any, @Body(body) dto: CreateDraftDto) {
    return this.mailbox.createDraft(request.user.id, dto);
  }

  @Patch('drafts/:id')
  @ApiOperation({ summary: 'Save changes to a draft' })
  updateDraft(
    @Req() request: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body) dto: UpdateDraftDto,
  ) {
    return this.mailbox.updateDraft(request.user.id, id, dto);
  }

  @Delete('drafts/:id')
  @ApiOperation({ summary: 'Discard a draft' })
  deleteDraft(@Req() request: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.mailbox.deleteDraft(request.user.id, id);
  }

  @Post('drafts/:id/send')
  @ApiOperation({
    summary: 'Send a draft after the undo delay, or schedule it with sendAt',
  })
  sendDraft(
    @Req() request: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body) dto: SendDraftDto,
  ) {
    return this.mailbox.sendDraft(request.user.id, id, dto);
  }

  @Post('messages/:id/cancel')
  @ApiOperation({ summary: 'Undo a send or cancel a scheduled send' })
  cancelSend(@Req() request: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.mailbox.cancelSend(request.user.id, id);
  }

  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES } }),
  )
  @ApiOperation({ summary: 'Upload a file to attach to a draft (10 MB max)' })
  upload(@Req() request: any, @UploadedFile() file: Express.Multer.File) {
    return this.mailbox.uploadAttachment(request.user.id, file);
  }

  @Get('attachments/:id')
  @ApiOperation({ summary: 'Download an attachment' })
  async download(
    @Req() request: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('inline') inline: string,
    @Res() response: Response,
  ) {
    const { file, contentType, stream } = await this.attachments.openDownload(
      request.user.id,
      id,
    );
    const showInline = inline === '1' && INLINE_TYPES.has(contentType);
    const name = (file.filename || 'attachment').replace(/[\r\n"\\]/g, '_');
    response.set({
      'Content-Type': showInline ? contentType : 'application/octet-stream',
      'Content-Length': String(file.length),
      'Content-Disposition': `${showInline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=3600',
    });
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
}

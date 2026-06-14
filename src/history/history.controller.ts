import { Controller, Get, Query } from '@nestjs/common';
import { HistoryService } from './history.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';

@ApiTags('history')
@Controller('history')
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('emails')
  @ApiOperation({ summary: 'Get email outreach history with filters' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'campaignId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'SENT', 'DELIVERED', 'FAILED'],
  })
  async getEmailHistory(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('campaignId') campaignId?: string,
    @Query('status') status?: string,
  ) {
    return this.historyService.getEmailHistory({
      startDate,
      endDate,
      campaignId,
      status,
    });
  }

  @Get('calls')
  @ApiOperation({ summary: 'Get calling outreach history with filters' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'campaignId', required: false })
  @ApiQuery({
    name: 'outcome',
    required: false,
    enum: ['PENDING', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED'],
  })
  async getCallHistory(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('campaignId') campaignId?: string,
    @Query('outcome') outcome?: string,
  ) {
    return this.historyService.getCallHistory({
      startDate,
      endDate,
      campaignId,
      outcome,
    });
  }
}

import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DecideIntentDto {
  @ApiProperty({ enum: ['approve', 'decline'] })
  @IsIn(['approve', 'decline'])
  decision: 'approve' | 'decline';

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  reason?: string;
}

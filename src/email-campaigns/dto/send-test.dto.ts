import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendTestDto {
  @ApiProperty()
  @IsUUID()
  templateId: string;

  @ApiProperty({
    required: false,
    description: 'Where to send the test; defaults to your Sender Email',
  })
  @IsString()
  @IsOptional()
  @MaxLength(320)
  to?: string;

  @ApiProperty({
    required: false,
    description: 'Fill the placeholders in with this contact',
  })
  @IsUUID()
  @IsOptional()
  contactId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(320)
  fromEmail?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  fromName?: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  unsubscribeLink?: boolean;
}

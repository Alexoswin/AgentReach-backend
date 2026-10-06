import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateCallingCampaignDto } from './create-calling-campaign.dto';

// The PATCH route previously typed its body as
// `Partial<CreateCallingCampaignDto>`, a TypeScript type that is erased at
// runtime — ValidationPipe had no metadata to check, so updates bypassed
// every rule the create route enforces (including the realtimeModel enum).
// PartialType keeps the decorators, so the same rules apply to updates.
export class UpdateCallingCampaignDto extends PartialType(
  CreateCallingCampaignDto,
) {
  @IsString()
  @IsOptional()
  status?: string;
}

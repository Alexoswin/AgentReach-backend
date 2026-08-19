import { PartialType } from '@nestjs/swagger';
import { CreateTemplateDto } from './create-template.dto';

/**
 * Every field optional, but still a real class so ValidationPipe has a metatype
 * to validate against. Typing the handler as `Partial<CreateTemplateDto>`
 * erases at runtime, which makes the pipe skip the body entirely — including
 * `whitelist` stripping and nested attachment validation.
 */
export class UpdateTemplateDto extends PartialType(CreateTemplateDto) {}

import { PartialType } from '@nestjs/swagger';
import { CreatePlaybookDto } from './create-playbook.dto';

export class UpdatePlaybookDto extends PartialType(CreatePlaybookDto) {}

import { BadRequestException, Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreatePlaybookDto } from './dto/create-playbook.dto';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';

export interface PlaybookLike {
  id: string;
  name: string;
  signalTypes: string[];
  directoryIds: string[];
  templateId: string;
  mode: string;
  cooldownDays: number;
  dailyCap: number;
  active: boolean;
  // Whose SES credentials send this playbook's automatic outreach.
  createdBy?: string | null;
}

@Injectable()
export class PlaybooksService {
  constructor(private readonly db: MongoService) {}

  async findAll(): Promise<PlaybookLike[]> {
    return this.db.playbook.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<PlaybookLike> {
    const playbook = await this.db.playbook.findUnique({ where: { id } });
    if (!playbook) throw new BadRequestException('Playbook not found');
    return playbook;
  }

  async create(dto: CreatePlaybookDto, userId: string): Promise<PlaybookLike> {
    const template = await this.db.template.findUnique({
      where: { id: dto.templateId },
    });
    if (!template) {
      throw new BadRequestException('Referenced template does not exist');
    }
    return this.db.playbook.create({ data: { ...dto, createdBy: userId } });
  }

  // Playbooks saved before credentials were per-user have no owner, so their
  // automatic sends cannot run; the next user to edit one adopts it.
  async update(
    id: string,
    dto: UpdatePlaybookDto,
    userId: string,
  ): Promise<PlaybookLike> {
    const playbook = await this.findOne(id);
    return this.db.playbook.update({
      where: { id },
      data: { ...dto, ...(playbook.createdBy ? {} : { createdBy: userId }) },
    });
  }

  async toggle(id: string, userId: string): Promise<PlaybookLike> {
    const playbook = await this.findOne(id);
    return this.db.playbook.update({
      where: { id },
      data: {
        active: !playbook.active,
        ...(playbook.createdBy ? {} : { createdBy: userId }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.db.playbook.delete({ where: { id } });
  }

  /**
   * Active playbooks that react to `signalType` and whose audience includes
   * the given contact (empty directoryIds = all contacts).
   */
  async findMatchingPlaybooks(
    signalType: string,
    contact: { directoryId?: string | null },
  ): Promise<PlaybookLike[]> {
    const all = await this.findAll();
    return all.filter((p) => {
      if (!p.active) return false;
      if (!p.signalTypes.includes(signalType)) return false;
      if (p.directoryIds.length === 0) return true;
      return (
        !!contact.directoryId && p.directoryIds.includes(contact.directoryId)
      );
    });
  }
}

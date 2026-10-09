import { BadRequestException, Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreatePlaybookDto } from './dto/create-playbook.dto';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';

export interface PlaybookLike {
  id: string;
  ownerId: string;
  name: string;
  signalTypes: string[];
  directoryIds: string[];
  templateId: string;
  mode: string;
  cooldownDays: number;
  dailyCap: number;
  active: boolean;
}

@Injectable()
export class PlaybooksService {
  constructor(private readonly db: MongoService) {}

  async findAll(userId: string): Promise<PlaybookLike[]> {
    return this.db.playbook.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string): Promise<PlaybookLike> {
    const playbook = await this.db.playbook.findUnique({
      where: { id, ownerId: userId },
    });
    if (!playbook) throw new BadRequestException('Playbook not found');
    return playbook;
  }

  async create(dto: CreatePlaybookDto, userId: string): Promise<PlaybookLike> {
    await this.assertReferencesOwned(dto, userId);
    // createdBy is kept for records written before ownerId existed.
    return this.db.playbook.create({
      data: { ...dto, ownerId: userId, createdBy: userId },
    });
  }

  async update(
    id: string,
    dto: UpdatePlaybookDto,
    userId: string,
  ): Promise<PlaybookLike> {
    await this.findOne(id, userId);
    await this.assertReferencesOwned(dto, userId);
    return this.db.playbook.update({
      where: { id, ownerId: userId },
      data: dto,
    });
  }

  async toggle(id: string, userId: string): Promise<PlaybookLike> {
    const playbook = await this.findOne(id, userId);
    return this.db.playbook.update({
      where: { id, ownerId: userId },
      data: { active: !playbook.active },
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.db.playbook.delete({ where: { id, ownerId: userId } });
  }

  /**
   * The owner's active playbooks that react to `signalType` and whose
   * audience includes the given contact (empty directoryIds = all contacts).
   */
  async findMatchingPlaybooks(
    signalType: string,
    contact: { directoryId?: string | null },
    userId: string,
  ): Promise<PlaybookLike[]> {
    const all = await this.findAll(userId);
    return all.filter((p) => {
      if (!p.active) return false;
      if (!p.signalTypes.includes(signalType)) return false;
      if (p.directoryIds.length === 0) return true;
      return (
        !!contact.directoryId && p.directoryIds.includes(contact.directoryId)
      );
    });
  }

  // A playbook may only point at the owner's own template, calling campaign
  // and directories.
  private async assertReferencesOwned(
    dto: Partial<CreatePlaybookDto>,
    userId: string,
  ) {
    if (dto.templateId) {
      const template = await this.db.template.findUnique({
        where: { id: dto.templateId, ownerId: userId },
      });
      if (!template) {
        throw new BadRequestException('Referenced template does not exist');
      }
    }
    if (dto.callCampaignId) {
      const campaign = await this.db.callingCampaign.findUnique({
        where: { id: dto.callCampaignId, ownerId: userId },
      });
      if (!campaign) {
        throw new BadRequestException(
          'Referenced calling campaign does not exist',
        );
      }
    }
    if (dto.directoryIds?.length) {
      const ids = [...new Set(dto.directoryIds)];
      const count = await this.db.contactDirectory.count({
        where: { id: { in: ids }, ownerId: userId },
      });
      if (count !== ids.length) {
        throw new BadRequestException('Referenced directory does not exist');
      }
    }
  }
}

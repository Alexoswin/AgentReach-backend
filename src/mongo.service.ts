import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DEFAULT_OPENROUTER_MODEL } from './config/openrouter';
import { hashPassword } from './auth/password';
import { User } from './schemas/user.schema';
import { SystemSettings } from './schemas/system-settings.schema';
import { Contact } from './schemas/contact.schema';
import { ContactDirectory } from './schemas/contact-directory.schema';
import { Template } from './schemas/template.schema';
import { EmailCampaign } from './schemas/email-campaign.schema';
import { EmailCampaignContact } from './schemas/email-campaign-contact.schema';
import { CallingCampaign } from './schemas/calling-campaign.schema';
import { CallHistory } from './schemas/call-history.schema';
import { AiCallingBot } from './schemas/ai-calling-bot.schema';
import { AiCallingBotEmbedding } from './schemas/ai-calling-bot-embedding.schema';

type AnyModel = Model<any>;

@Injectable()
export class MongoService implements OnModuleInit {
  user: MongoDelegate;
  systemSettings: MongoDelegate;
  contact: MongoDelegate;
  contactDirectory: MongoDelegate;
  template: MongoDelegate;
  emailCampaign: MongoDelegate;
  emailCampaignContact: MongoDelegate;
  callingCampaign: MongoDelegate;
  callHistory: MongoDelegate;
  aiCallingBot: MongoDelegate;
  aiCallingBotEmbedding: MongoDelegate;

  constructor(
    @InjectModel(User.name) private userModel: AnyModel,
    @InjectModel(SystemSettings.name) private systemSettingsModel: AnyModel,
    @InjectModel(Contact.name) private contactModel: AnyModel,
    @InjectModel(ContactDirectory.name) private contactDirectoryModel: AnyModel,
    @InjectModel(Template.name) private templateModel: AnyModel,
    @InjectModel(EmailCampaign.name) private emailCampaignModel: AnyModel,
    @InjectModel(EmailCampaignContact.name)
    private emailCampaignContactModel: AnyModel,
    @InjectModel(CallingCampaign.name) private callingCampaignModel: AnyModel,
    @InjectModel(CallHistory.name) private callHistoryModel: AnyModel,
    @InjectModel(AiCallingBot.name) private aiCallingBotModel: AnyModel,
    @InjectModel(AiCallingBotEmbedding.name)
    private aiCallingBotEmbeddingModel: AnyModel,
  ) {
    const models = () => ({
      user: this.userModel,
      systemSettings: this.systemSettingsModel,
      contact: this.contactModel,
      contactDirectory: this.contactDirectoryModel,
      template: this.templateModel,
      emailCampaign: this.emailCampaignModel,
      emailCampaignContact: this.emailCampaignContactModel,
      callingCampaign: this.callingCampaignModel,
      callHistory: this.callHistoryModel,
      aiCallingBot: this.aiCallingBotModel,
      aiCallingBotEmbedding: this.aiCallingBotEmbeddingModel,
    });

    this.user = new MongoDelegate('user', this.userModel, models);
    this.systemSettings = new MongoDelegate(
      'systemSettings',
      this.systemSettingsModel,
      models,
    );
    this.contact = new MongoDelegate('contact', this.contactModel, models);
    this.contactDirectory = new MongoDelegate(
      'contactDirectory',
      this.contactDirectoryModel,
      models,
    );
    this.template = new MongoDelegate('template', this.templateModel, models);
    this.emailCampaign = new MongoDelegate(
      'emailCampaign',
      this.emailCampaignModel,
      models,
    );
    this.emailCampaignContact = new MongoDelegate(
      'emailCampaignContact',
      this.emailCampaignContactModel,
      models,
    );
    this.callingCampaign = new MongoDelegate(
      'callingCampaign',
      this.callingCampaignModel,
      models,
    );
    this.callHistory = new MongoDelegate(
      'callHistory',
      this.callHistoryModel,
      models,
    );
    this.aiCallingBot = new MongoDelegate(
      'aiCallingBot',
      this.aiCallingBotModel,
      models,
    );
    this.aiCallingBotEmbedding = new MongoDelegate(
      'aiCallingBotEmbedding',
      this.aiCallingBotEmbeddingModel,
      models,
    );
  }

  async onModuleInit() {
    await this.systemSettings.upsert({
      where: { id: 'default' },
      update: {
        awsAccessKeyId: process.env.AWS_KEY_ID || '',
        awsSecretAccessKey: process.env.AWS_KEY || '',
        openRouterApiKey: process.env.OPENROUTER_KEY || '',
        openRouterModel: DEFAULT_OPENROUTER_MODEL,
      },
      create: {
        id: 'default',
        awsAccessKeyId: process.env.AWS_KEY_ID || '',
        awsSecretAccessKey: process.env.AWS_KEY || '',
        awsRegion: 'us-east-1',
        awsSenderEmail: 'oswin.alex@oswinalex.site',
        openRouterApiKey: process.env.OPENROUTER_KEY || '',
        openRouterModel: DEFAULT_OPENROUTER_MODEL,
      },
    });

    const defaultEmail = 'oswinalex1@gmail.com';
    const existingUser = await this.user.findUnique({
      where: { email: defaultEmail },
    });
    if (!existingUser) {
      await this.user.create({
        data: {
          email: defaultEmail,
          passwordHash: await hashPassword('DBIT@2026'),
          name: 'Oswin Alex',
          initials: 'OA',
          title: 'Founder',
          company: 'ReachConvert',
          theme: 'dark-midnight',
          accentColor: 'indigo',
        },
      });
    } else {
      await this.user.update({
        where: { id: existingUser.id },
        data: {
          theme:
            existingUser.theme === 'light'
              ? 'light-cloud'
              : existingUser.theme === 'dark'
                ? 'dark-midnight'
                : existingUser.theme || 'dark-midnight',
          accentColor: existingUser.accentColor || 'indigo',
        },
      });
    }
  }
}

class MongoDelegate {
  constructor(
    private name: string,
    private model: AnyModel,
    private getModels: () => Record<string, AnyModel>,
  ) {}

  async findMany(args: any = {}) {
    const docs = await this.model
      .find(this.toMongoWhere(args.where))
      .sort(this.toMongoSort(args.orderBy) as any)
      .lean();

    return Promise.all(
      docs.map((doc) =>
        this.hydrate(this.toApi(doc), args.include, args.select),
      ),
    );
  }

  async findUnique(args: any) {
    const doc = await this.model.findOne(this.toMongoWhere(args.where)).lean();
    return doc
      ? this.hydrate(this.toApi(doc), args.include, args.select)
      : null;
  }

  async findFirst(args: any = {}) {
    const doc = await this.model
      .findOne(this.toMongoWhere(args.where))
      .sort(this.toMongoSort(args.orderBy) as any)
      .lean();
    return doc
      ? this.hydrate(this.toApi(doc), args.include, args.select)
      : null;
  }

  async create(args: any) {
    const data = this.toMongoData(args.data);
    const created = await this.model.create(data);
    return this.hydrate(
      this.toApi(created.toObject()),
      args.include,
      args.select,
    );
  }

  async update(args: any) {
    const updated = await this.model
      .findOneAndUpdate(
        this.toMongoWhere(args.where),
        { $set: this.toMongoData(args.data) },
        { returnDocument: 'after' },
      )
      .lean();

    return updated
      ? this.hydrate(this.toApi(updated), args.include, args.select)
      : null;
  }

  async updateMany(args: any) {
    const result = await this.model.updateMany(this.toMongoWhere(args.where), {
      $set: this.toMongoData(args.data),
    });
    return { count: result.modifiedCount };
  }

  async delete(args: any) {
    const deleted = await this.model
      .findOneAndDelete(this.toMongoWhere(args.where))
      .lean();
    return deleted ? this.toApi(deleted) : null;
  }

  async deleteMany(args: any = {}) {
    const result = await this.model.deleteMany(this.toMongoWhere(args.where));
    return { count: result.deletedCount };
  }

  async upsert(args: any) {
    const query = this.toMongoWhere(args.where);
    const existing = await this.model.findOne(query).lean();

    if (existing) {
      const updated = await this.model
        .findOneAndUpdate(
          query,
          { $set: this.toMongoData(args.update) },
          { returnDocument: 'after' },
        )
        .lean();
      return this.toApi(updated);
    }

    return this.create({ data: { ...args.create, ...args.where } });
  }

  private toMongoWhere(where: any = {}) {
    const query: any = {};

    for (const [key, value] of Object.entries(where)) {
      const field = key === 'id' ? '_id' : key;
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const range: any = {};
        if ('gte' in value) range.$gte = value.gte;
        if ('lte' in value) range.$lte = value.lte;
        query[field] = Object.keys(range).length > 0 ? range : value;
      } else {
        query[field] = value;
      }
    }

    return query;
  }

  private toMongoData(data: any = {}) {
    const next: any = {};

    for (const [key, value] of Object.entries(data)) {
      next[key === 'id' ? '_id' : key] = value;
    }

    return next;
  }

  private toMongoSort(orderBy?: Record<string, 'asc' | 'desc'>) {
    if (!orderBy) return undefined;
    return Object.fromEntries(
      Object.entries(orderBy).map(([key, direction]) => [
        key === 'id' ? '_id' : key,
        direction === 'desc' ? -1 : 1,
      ]),
    );
  }

  private toApi(doc: any) {
    if (!doc) return doc;
    const { _id, ...rest } = doc;
    delete rest.__v;
    return {
      id: _id?.toString(),
      ...rest,
    };
  }

  private applySelect(value: any, select: any) {
    if (!select || !value) return value;
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, enabled]) => enabled)
        .map(([key]) => [key, value[key]]),
    );
  }

  private async hydrate(value: any, include?: any, select?: any): Promise<any> {
    if (!value) return value;
    const next = this.applySelect(value, select);
    if (!include) return next;

    const models = this.getModels();

    if (this.name === 'emailCampaign') {
      if (include.template) {
        const template = value.templateId
          ? await models.template.findOne({ _id: value.templateId }).lean()
          : null;
        next.template = this.applySelect(
          this.toApi(template),
          include.template.select,
        );
      }

      if (include.contacts) {
        const contactDelegate = new MongoDelegate(
          'emailCampaignContact',
          models.emailCampaignContact,
          this.getModels,
        );
        next.contacts = await contactDelegate.findMany({
          where: { campaignId: value.id, ...(include.contacts.where || {}) },
          include: include.contacts.include,
          select: include.contacts.select,
        });
      }
    }

    if (this.name === 'emailCampaignContact') {
      if (include.contact) {
        next.contact = this.toApi(
          await models.contact.findOne({ _id: value.contactId }).lean(),
        );
      }

      if (include.campaign) {
        const campaign = this.toApi(
          await models.emailCampaign.findOne({ _id: value.campaignId }).lean(),
        );
        if (campaign && include.campaign.include?.template) {
          campaign.template = campaign.templateId
            ? this.toApi(
                await models.template
                  .findOne({ _id: campaign.templateId })
                  .lean(),
              )
            : null;
        }
        next.campaign = this.applySelect(campaign, include.campaign.select);
      }
    }

    if (this.name === 'callingCampaign' && include.calls) {
      const callDelegate = new MongoDelegate(
        'callHistory',
        models.callHistory,
        this.getModels,
      );
      next.calls = await callDelegate.findMany({
        where: { campaignId: value.id, ...(include.calls.where || {}) },
        include: include.calls.include,
        select: include.calls.select,
      });
    }

    if (this.name === 'callHistory') {
      if (include.contact) {
        next.contact = this.toApi(
          await models.contact.findOne({ _id: value.contactId }).lean(),
        );
      }

      if (include.campaign) {
        const campaign = this.toApi(
          await models.callingCampaign
            .findOne({ _id: value.campaignId })
            .lean(),
        );
        next.campaign = this.applySelect(campaign, include.campaign.select);
      }
    }

    return next;
  }
}

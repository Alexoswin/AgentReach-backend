import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_OPENROUTER_MODEL } from './config/openrouter';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    // Seed initial settings if not present
    try {
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
          awsSenderEmail: 'oswinalex@gmail.com',
          openRouterApiKey: process.env.OPENROUTER_KEY || '',
          openRouterModel: DEFAULT_OPENROUTER_MODEL,
        },
      });
    } catch (e) {
      console.error('Failed to seed default settings:', e);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

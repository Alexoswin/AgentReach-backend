import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_OPENROUTER_MODEL } from './config/openrouter';
import { hashPassword } from './auth/password';

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

      const defaultEmail = 'oswinalex1@gmail.com';
      const existingUser = await this.user.findUnique({ where: { email: defaultEmail } });
      if (!existingUser) {
        await this.user.create({
          data: {
            email: defaultEmail,
            passwordHash: await hashPassword('DBIT@2026'),
            name: 'Oswin Alex',
            initials: 'OA',
            title: 'Founder',
            company: 'ReachConvert',
            theme: 'dark',
          },
        });
      }
    } catch (e) {
      console.error('Failed to seed default settings:', e);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

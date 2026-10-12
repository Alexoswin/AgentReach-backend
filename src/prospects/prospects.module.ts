import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { SettingsModule } from '../settings/settings.module';
import { SignalsModule } from '../signals/signals.module';
import { ProspectsController } from './prospects.controller';
import { ProspectsService } from './prospects.service';

@Module({
  imports: [SettingsModule, ContactsModule, SignalsModule],
  controllers: [ProspectsController],
  providers: [ProspectsService],
})
export class ProspectsModule {}

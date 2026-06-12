import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { ImportContactsDto } from './dto/import-contacts.dto';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

@ApiTags('contacts')
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contacts' })
  async findAll() {
    return this.contactsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a contact by ID' })
  async findOne(@Param('id') id: string) {
    return this.contactsService.findOne(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a contact manually' })
  async create(@Body() dto: CreateContactDto) {
    return this.contactsService.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update contact details' })
  async update(@Param('id') id: string, @Body() dto: Partial<CreateContactDto>) {
    return this.contactsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a contact' })
  async remove(@Param('id') id: string) {
    return this.contactsService.remove(id);
  }

  @Post('parse-file')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload and parse CSV or XLSX contacts file for column mapping' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async parseFile(@UploadedFile() file: Express.Multer.File) {
    return this.contactsService.parseFile(file);
  }

  @Post('import')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Import contacts using column mapping' })
  async importContacts(@Body() dto: ImportContactsDto) {
    return this.contactsService.importContacts(dto);
  }
}

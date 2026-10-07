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
import { CreateContactDirectoryDto } from './dto/create-contact-directory.dto';
import { UpdateContactDirectoryDto } from './dto/update-contact-directory.dto';
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

  @Get('directories')
  @ApiOperation({ summary: 'Get contact directories' })
  async findDirectories() {
    return this.contactsService.findDirectories();
  }

  @Post('directories')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a contact directory' })
  async createDirectory(@Body() dto: CreateContactDirectoryDto) {
    return this.contactsService.createDirectory(dto);
  }

  @Patch('directories/:id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update a contact directory' })
  async updateDirectory(
    @Param('id') id: string,
    @Body() dto: UpdateContactDirectoryDto,
  ) {
    return this.contactsService.updateDirectory(id, dto);
  }

  @Delete('directories/:id')
  @ApiOperation({
    summary: 'Delete a contact directory and unassign its contacts',
  })
  async removeDirectory(@Param('id') id: string) {
    return this.contactsService.removeDirectory(id);
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
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateContactDto>,
  ) {
    return this.contactsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a contact' })
  async remove(@Param('id') id: string) {
    return this.contactsService.remove(id);
  }

  @Post('parse-file')
  // Stop oversized uploads while streaming instead of buffering them first.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload and parse CSV or XLSX contacts file for column mapping',
  })
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

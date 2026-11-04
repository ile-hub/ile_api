import {
  Body,
  Delete,
  Put,
  UploadedFile,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  FILE_LIMIT,
  type UploadedAsset,
} from '../common/private-storage.service';
import { PropertyArcsDto } from '../landlords/arcs-preferences.dto';
import { AvailabilityDto, UpdatePhotoDto } from './dto/property-details.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import {
  CreatePropertyDto,
  PropertyFeedQueryDto,
  UpdatePropertyDto,
} from './dto/property.dto';
import { PropertiesService } from './properties.service';

// Status only moves through the two named actions below (publish,
// archive) -- there is no generic status setter, and PATCH rejects a
// `status` field outright (ValidationPipe forbidNonWhitelisted).
@Controller()
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Post('properties')
  async create(@Body() body: CreatePropertyDto) {
    return this.properties.create(body);
  }

  // Declared before ':id' so 'me' isn't parsed as an id.
  @Get('properties/me')
  async listMine() {
    return this.properties.listMine();
  }

  @Get('properties')
  async feed(@Query() query: PropertyFeedQueryDto) {
    return this.properties.feed(query.limit, query.offset);
  }

  @Get('properties/:id')
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.properties.getById(id);
  }

  @Patch('properties/:id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePropertyDto,
  ) {
    return this.properties.update(id, body);
  }

  @Post('properties/:id/publish')
  @HttpCode(200)
  async publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.properties.publish(id);
  }

  @Post('properties/:id/archive')
  @HttpCode(200)
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.properties.archive(id);
  }
  @Post('properties/:id/availability')
  @HttpCode(200)
  availability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AvailabilityDto,
  ) {
    return this.properties.availability(id, body.status);
  }
  @Get('properties/:id/arcs-preferences') arcs(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.properties.arcs(id);
  }
  @Put('properties/:id/arcs-preferences') saveArcs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PropertyArcsDto,
  ) {
    return this.properties.saveArcs(id, body);
  }
  @Get('properties/:id/photos') photos(@Param('id', ParseUUIDPipe) id: string) {
    return this.properties.photos(id);
  }
  @Post('properties/:id/photos')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: FILE_LIMIT, files: 1 } }),
  )
  uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedAsset,
  ) {
    return this.properties.uploadPhoto(id, file);
  }
  @Patch('properties/:id/photos/:photoId') updatePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Body() body: UpdatePhotoDto,
  ) {
    return this.properties.updatePhoto(id, photoId, body);
  }
  @Delete('properties/:id/photos/:photoId') removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ) {
    return this.properties.removePhoto(id, photoId);
  }
  @Get('properties/:id/photos/:photoId/download') downloadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ) {
    return this.properties.downloadPhoto(id, photoId);
  }
  @Get('landlords/:landlordId/properties') publicList(
    @Param('landlordId', ParseUUIDPipe) id: string,
  ) {
    return this.properties.publicList(id);
  }
  @Get('landlords/:landlordId/properties/:id') publicDetail(
    @Param('landlordId', ParseUUIDPipe) landlordId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.properties.publicDetail(landlordId, id);
  }
  @Get('landlords/:landlordId/properties/:id/photos/:photoId/download')
  publicPhoto(
    @Param('landlordId', ParseUUIDPipe) landlordId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ) {
    return this.properties.downloadPhoto(id, photoId, landlordId);
  }
}

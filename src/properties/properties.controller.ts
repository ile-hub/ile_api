import {
  Body,
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
import type { Property, PropertyFeedResponse } from '@yourorg/ile-shared-types';
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
@Controller('properties')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Post()
  async create(@Body() body: CreatePropertyDto): Promise<Property> {
    return this.properties.create(body);
  }

  // Declared before ':id' so 'me' isn't parsed as an id.
  @Get('me')
  async listMine(): Promise<Property[]> {
    return this.properties.listMine();
  }

  @Get()
  async feed(
    @Query() query: PropertyFeedQueryDto,
  ): Promise<PropertyFeedResponse> {
    return this.properties.feed(query.limit, query.offset);
  }

  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<Property> {
    return this.properties.getById(id);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePropertyDto,
  ): Promise<Property> {
    return this.properties.update(id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  async publish(@Param('id', ParseUUIDPipe) id: string): Promise<Property> {
    return this.properties.publish(id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(@Param('id', ParseUUIDPipe) id: string): Promise<Property> {
    return this.properties.archive(id);
  }
}

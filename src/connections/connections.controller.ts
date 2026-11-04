import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import {
  ConnectionQuery,
  CreateConnectionDto,
  MessageQuery,
  SendMessageDto,
} from './connections.dto';
import { ConnectionsService } from './connections.service';
@Controller('connections')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}
  @Post() create(@Body() body: CreateConnectionDto) {
    return this.connections.create(body);
  }
  @Get() list(@Query() query: ConnectionQuery) {
    return this.connections.list(query);
  }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(id);
  }
  @Post(':id/accept') @HttpCode(200) accept(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.connections.decide(id, 'accepted');
  }
  @Post(':id/decline') @HttpCode(200) decline(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.connections.decide(id, 'declined');
  }
  @Post(':id/review-later') @HttpCode(200) later(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.connections.decide(id, 'review_later');
  }
  @Get(':id/messages') messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MessageQuery,
  ) {
    return this.connections.messages(id, query);
  }
  @Post(':id/messages') send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.connections.send(id, body);
  }
}

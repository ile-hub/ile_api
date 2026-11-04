import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import { DiscoveryQuery } from './discovery';
import { UpdateProfileDto } from './profile.dto';
import { ProfilesService } from './profiles.service';

@Controller()
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}
  @Get('discovery') discover(@Query() query: DiscoveryQuery) {
    return this.profiles.discover(query);
  }
  @Get('me/profile') getOwn() {
    return this.profiles.getOwn();
  }
  @Patch('me/profile') update(@Body() body: UpdateProfileDto) {
    return this.profiles.update(body);
  }
  @Get('me/profile/preview') preview() {
    return this.profiles.preview();
  }
  @Get('profiles/:id') getPublic(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.getPublic(id);
  }
}

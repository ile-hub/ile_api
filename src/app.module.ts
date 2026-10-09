import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { EvidenceModule } from './evidence/evidence.module';
import { HealthModule } from './health/health.module';
import { MeModule } from './me/me.module';
import { PropertiesModule } from './properties/properties.module';
import { TenancyInterestsModule } from './tenancy-interests/tenancy-interests.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    DatabaseModule,
    HealthModule,
    MeModule,
    EvidenceModule,
    PropertiesModule,
    TenancyInterestsModule,
  ],
  providers: [
    // Registered as APP_PIPE rather than app.useGlobalPipes() in main.ts
    // so e2e tests (which build the app from AppModule, not main.ts) get
    // exactly the same validation as production.
    //
    // whitelist + forbidNonWhitelisted: an unknown body field is a 400,
    // not silently dropped -- e.g. PATCH /properties/:id with
    // { status: 'published' } is rejected outright rather than appearing
    // to succeed while ignoring the field.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}

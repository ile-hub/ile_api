import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { ConnectionsModule } from './connections/connections.module';
import { EvidenceModule } from './evidence/evidence.module';
import { HealthModule } from './health/health.module';
import { LandlordsModule } from './landlords/landlords.module';
import { MeModule } from './me/me.module';
import { PrivacyModule } from './privacy/privacy.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PropertiesModule } from './properties/properties.module';
import { TenancyInterestsModule } from './tenancy-interests/tenancy-interests.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.E2E_ISOLATED_LOCAL === '1',
    }),
    CommonModule,
    DatabaseModule,
    HealthModule,
    MeModule,
    ProfilesModule,
    ConnectionsModule,
    PrivacyModule,
    EvidenceModule,
    PropertiesModule,
    LandlordsModule,
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

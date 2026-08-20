import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { EmailAlreadyRegisteredFilter } from './filters/email-already-registered.filter';
import { APP_FILTER } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccountInactiveFilter } from './filters/account-inactive.filter';
import { InvalidCredentialsFilter } from './filters/invalid-credentials.filter';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    UsersModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('auth.accessTokenSecret'),
        signOptions: {
          expiresIn: configService.getOrThrow<number>(
            'auth.accessTokenExpiresIn',
          ),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_FILTER,
      useClass: EmailAlreadyRegisteredFilter,
    },
    {
      provide: APP_FILTER,
      useClass: AccountInactiveFilter,
    },
    {
      provide: APP_FILTER,
      useClass: InvalidCredentialsFilter,
    },
  ],
})
export class AuthModule {}

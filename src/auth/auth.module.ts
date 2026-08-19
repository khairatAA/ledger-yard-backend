import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from 'src/users/users.module';
import { EmailAlreadyRegisteredFilter } from './filters/email-already-registered.filter';
import { APP_FILTER } from '@nestjs/core';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_FILTER,
      useClass: EmailAlreadyRegisteredFilter,
    },
  ],
})
export class AuthModule {}

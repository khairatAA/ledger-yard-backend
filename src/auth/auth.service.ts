import { Injectable } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { UsersService } from '../users/users.service';
import { EmailAlreadyRegisteredException } from './exceptions/email-already-registered.exception';
import * as argon2 from 'argon2';
import { RegisterResponseDto } from './dto/register-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { InvalidCredentialsException } from './exceptions/invalid-credentials.exception';
import { AccountInactiveException } from './exceptions/account-inactive.exception';
import { AccessTokenPayload } from './types/access-token-payload.type';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const emailAlreadyExists =
      await this.usersService.existsByEmail(normalizedEmail);

    if (emailAlreadyExists) {
      throw new EmailAlreadyRegisteredException();
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    return this.usersService.create({
      fullName: dto.fullName,
      email: normalizedEmail,
      passwordHash,
    });
  }

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const user = await this.usersService.findForAuthentication(normalizedEmail);

    if (!user) {
      throw new InvalidCredentialsException();
    }

    const passwordIsValid = await argon2.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordIsValid) {
      throw new InvalidCredentialsException();
    }

    if (!user.isActive) {
      throw new AccountInactiveException();
    }

    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    const expiresIn = this.configService.getOrThrow<number>(
      'auth.accessTokenExpiresIn',
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: expiresIn,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        isActive: user.isActive,
      },
    };
  }
}

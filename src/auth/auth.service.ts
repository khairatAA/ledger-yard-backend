import { Injectable } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { UsersService } from 'src/users/users.service';
import { EmailAlreadyRegisteredException } from './exceptions/email-already-registered.exception';
import * as argon2 from 'argon2';
import { RegisterResponseDto } from './dto/register-response.dto';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

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
}

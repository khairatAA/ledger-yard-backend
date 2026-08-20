import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PublicUser } from './types/public-user.type';
import { CreateUserData } from './types/create-user-data.type';
import { AuthenticationUser } from './types/authentication-user.type';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async existsByEmail(email: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    return !!user;
  }

  async create(data: CreateUserData): Promise<PublicUser> {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async findForAuthentication(
    email: string,
  ): Promise<AuthenticationUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        passwordHash: true,
      },
    });
  }
}

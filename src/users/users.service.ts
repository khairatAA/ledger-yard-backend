import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { PublicUser } from './types/public-user.type';
import { CreateUserData } from './types/create-user-data.type';

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
}

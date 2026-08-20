import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => {
  const accessTokenExpiresIn = Number(process.env.JWT_ACCESS_EXPIRES_IN);

  if (!Number.isInteger(accessTokenExpiresIn) || accessTokenExpiresIn <= 0) {
    throw new Error('JWT_ACCESS_EXPIRES_IN must be a positive integer');
  }

  if (!process.env.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET is not configured');
  }

  return {
    accessTokenSecret: process.env.JWT_ACCESS_SECRET,
    accessTokenExpiresIn,
  };
});

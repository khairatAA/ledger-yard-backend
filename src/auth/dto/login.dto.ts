import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  /**
   * User's email address.
   * @example khairat@example.com
   */
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /**
   * User's password.
   * @example SecurePass123!
   */
  @IsString()
  @MaxLength(128)
  password!: string;
}

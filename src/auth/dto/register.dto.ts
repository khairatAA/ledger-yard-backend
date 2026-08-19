import {
  IsEmail,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  /**
   * User's full name.
   * @example Khairat Adesina
   */
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  fullName!: string;

  /**
   * User's email address.
   * @example khairat@example.com
   */
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /**
   * Strong password containing uppercase, lowercase, number and symbol.
   * @example SecurePass123!
   */
  @IsString()
  @MaxLength(128)
  @IsStrongPassword()
  password!: string;
}

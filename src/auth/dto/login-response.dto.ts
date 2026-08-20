class LoginUserResponseDto {
  /**
   * Unique user identifier.
   * @example 8fde5330-f908-4d8d-b39f-d8b3c81efc98
   */
  id!: string;

  /**
   * User's full name.
   * @example Khairat Adesina
   */
  fullName!: string;

  /**
   * Normalized email address.
   * @example khairat@example.com
   */
  email!: string;

  /**
   * Whether the user account is active.
   * @example true
   */
  isActive!: boolean;
}

export class LoginResponseDto {
  /**
   * JWT access token.
   */
  accessToken!: string;

  /**
   * Authentication scheme used when sending the token.
   * @example Bearer
   */
  tokenType!: string;

  /**
   * Access-token lifetime in seconds.
   * @example 900
   */
  expiresIn!: number;

  user!: LoginUserResponseDto;
}

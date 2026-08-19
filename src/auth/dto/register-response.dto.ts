export class RegisterResponseDto {
  /**
   * Unique identifier of the registered user.
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

  /**
   * Account creation time.
   * @example 2026-08-19T10:00:00.000Z
   */
  createdAt!: Date;
}

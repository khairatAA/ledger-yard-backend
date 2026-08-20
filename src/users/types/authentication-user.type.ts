export interface AuthenticationUser {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  passwordHash: string;
}

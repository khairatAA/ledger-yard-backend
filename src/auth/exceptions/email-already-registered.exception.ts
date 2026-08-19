export class EmailAlreadyRegisteredException extends Error {
  constructor() {
    super('An account already exists with this email');
    this.name = EmailAlreadyRegisteredException.name;
  }
}

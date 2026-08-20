export class AccountInactiveException extends Error {
  constructor() {
    super('This account has been disabled');
    this.name = AccountInactiveException.name;
  }
}

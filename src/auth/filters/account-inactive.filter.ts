import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { AccountInactiveException } from '../exceptions/account-inactive.exception';

@Catch(AccountInactiveException)
export class AccountInactiveFilter implements ExceptionFilter {
  catch(exception: AccountInactiveException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response.status(HttpStatus.FORBIDDEN).json({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      message: exception.message,
    });
  }
}

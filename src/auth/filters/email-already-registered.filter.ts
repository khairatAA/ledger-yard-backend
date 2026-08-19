import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { EmailAlreadyRegisteredException } from '../exceptions/email-already-registered.exception';

@Catch(EmailAlreadyRegisteredException)
export class EmailAlreadyRegisteredFilter implements ExceptionFilter {
  catch(exception: EmailAlreadyRegisteredException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response.status(HttpStatus.CONFLICT).json({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: exception.message,
    });
  }
}

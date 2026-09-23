import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Structured error response format
 */
export interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error?: string;
  errorCode?: string;
  details?: Record<string, any>;
  requestId: string;
}

/**
 * Global exception filter that transforms all exceptions into a consistent,
 * structured error response format.
 *
 * Features:
 * - Consistent error structure across all endpoints
 * - Proper HTTP status codes
 * - Request context (path, method, timestamp)
 * - requestId correlation on every error response and log line
 * - Error logging with context
 * - Security: No stack traces or sensitive data in production
 * - Support for validation errors and custom error details
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = this.resolveRequestId(request);
    const errorResponse = this.buildErrorResponse(exception, request, requestId);

    // Log error with context
    this.logError(exception, request, errorResponse);

    // Send structured error response
    response.status(errorResponse.statusCode).json(errorResponse);
  }

  /**
   * Resolve the correlation id for the current request, generating one when
   * the client did not supply a valid `x-request-id` header.
   */
  private resolveRequestId(request: Request): string {
    const header = request.headers['x-request-id'];
    const incoming = Array.isArray(header) ? header[0] : header;

    if (typeof incoming === 'string' && incoming.trim().length > 0) {
      return incoming.trim();
    }

    return randomUUID();
  }

  /**
   * Build a structured error response from any exception type
   */
  private buildErrorResponse(
    exception: unknown,
    request: Request,
    requestId: string,
  ): ErrorResponse {
    const timestamp = new Date().toISOString();
    const path = request.url;
    const method = request.method;

    // Handle HttpException (NestJS exceptions)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Extract message and details from exception response
      const { message, error, errorCode, details } =
        this.parseHttpExceptionResponse(exceptionResponse, status);

      return {
        statusCode: status,
        timestamp,
        path,
        method,
        message,
        error,
        ...(errorCode && { errorCode }),
        ...(details && { details }),
        requestId,
      };
    }

    // Handle standard Error objects
    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        timestamp,
        path,
        method,
        message: this.sanitizeErrorMessage(exception.message),
        error: 'Internal Server Error',
        requestId,
      };
    }

    // Handle unknown exception types
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      timestamp,
      path,
      method,
      message: 'An unexpected error occurred',
      error: 'Internal Server Error',
      requestId,
    };
  }

  /**
   * Parse HttpException response to extract message, error name, and details
   */
  private parseHttpExceptionResponse(
    exceptionResponse: string | object,
    status: number,
  ): {
    message: string | string[];
    error: string;
    errorCode?: string;
    details?: Record<string, any>;
  } {
    // If response is a string, use it as the message
    if (typeof exceptionResponse === 'string') {
      return {
        message: this.sanitizeMessage(exceptionResponse, status),
        error: this.getErrorNameFromStatus(status),
      };
    }

    // If response is an object, extract structured data
    const responseObj = exceptionResponse as any;

    return {
      message: this.sanitizeMessage(
        responseObj.message || 'An error occurred',
        status,
      ),
      error: responseObj.error || this.getErrorNameFromStatus(status),
      ...(responseObj.errorCode && { errorCode: responseObj.errorCode }),
      ...(responseObj.details && { details: responseObj.details }),
    };
  }

  /**
   * Get standard error name from HTTP status code
   */
  private getErrorNameFromStatus(status: number): string {
    const errorNames: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    return errorNames[status] || 'Error';
  }

  /**
   * Sanitize an error message (string or array) for the outgoing envelope.
   * In production, server errors are replaced with a generic message so that
   * internal details, stack traces, secrets, JWTs, or key material never leak.
   */
  private sanitizeMessage(
    message: string | string[],
    status: number,
  ): string | string[] {
    if (Array.isArray(message)) {
      return message.map((entry) => this.sanitizeMessage(entry, status) as string);
    }

    if (process.env.NODE_ENV === 'production' && status >= 500) {
      return 'Internal Server Error';
    }

    return this.sanitizeErrorMessage(message);
  }

  /**
   * Sanitize error messages to prevent sensitive data leakage
   */
  private sanitizeErrorMessage(message: string): string {
    // In production, sanitize potentially sensitive error messages
    if (process.env.NODE_ENV === 'production') {
      // Remove database connection strings
      message = message.replace(/postgresql:\/\/[^\s]+/gi, '[DATABASE_URL]');
      // Remove file paths
      message = message.replace(/[A-Z]:\\[^\s]+/gi, '[FILE_PATH]');
      message = message.replace(/\/[^\s]+\.(ts|js|json)/gi, '[FILE_PATH]');
      // Remove potential secrets
      message = message.replace(/api[_-]?key[:\s=]+[^\s]+/gi, '[API_KEY]');
      message = message.replace(/secret[:\s=]+[^\s]+/gi, '[SECRET]');
      message = message.replace(/password[:\s=]+[^\s]+/gi, '[PASSWORD]');
      // Remove bearer tokens / JWTs
      message = message.replace(/bearer\s+[A-Za-z0-9._-]+/gi, '[TOKEN]');
      message = message.replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        '[JWT]',
      );
      // Remove raw private/secret key material
      message = message.replace(/S[A-Z2-7]{55}/g, '[STELLAR_KEY]');
    }

    return message;
  }

  /**
   * Log error with appropriate level and context
   */
  private logError(
    exception: unknown,
    request: Request,
    errorResponse: ErrorResponse,
  ): void {
    const { statusCode, path, method, message, requestId } = errorResponse;

    // Build log context
    const logContext = {
      requestId,
      method,
      path,
      statusCode,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    };

    // Log based on severity
    if (statusCode >= 500) {
      // Server errors - log as error with full exception
      this.logger.error(
        `Server Error: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
        JSON.stringify(logContext),
      );
    } else if (statusCode >= 400) {
      // Client errors - log as warning
      this.logger.warn(`Client Error: ${message}`, JSON.stringify(logContext));
    } else {
      // Other errors - log as debug
      this.logger.debug(`Error: ${message}`, JSON.stringify(logContext));
    }
  }
}

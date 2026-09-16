/** Uniform API error shape. Clients switch on `code`, never on prose. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, detail?: Record<string, unknown>): ApiError {
    return new ApiError(400, code, message, detail);
  }
  static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Not permitted.'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  }
  static conflict(code: string, message: string, detail?: Record<string, unknown>): ApiError {
    return new ApiError(409, code, message, detail);
  }
}

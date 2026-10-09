export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 501,
    readonly code: string,
    message?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
  }
}

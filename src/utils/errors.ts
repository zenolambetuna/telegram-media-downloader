export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnsupportedProviderError extends AppError {
  constructor() {
    super('Unsupported provider', 'UNSUPPORTED_PROVIDER', 400);
  }
}

export class InvalidUrlError extends AppError {
  constructor() {
    super('Invalid URL', 'INVALID_URL', 400);
  }
}

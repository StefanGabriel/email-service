export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

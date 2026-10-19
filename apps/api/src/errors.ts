export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, 'VALIDATION_ERROR', message);
export const forbidden = () => new HttpError(403, 'FORBIDDEN', 'この操作を行う権限がありません');
export const notFound = () => new HttpError(404, 'NOT_FOUND', '対象が見つかりません');
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

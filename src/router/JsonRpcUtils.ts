import { Response } from 'express';

export interface IJsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown | null;
  } | null;
  id: string | number | null;
}

export function sendJsonRpcError(
  res: Response,
  httpStatus: number,
  errorCode: number,
  message: string,
  id: string | number | null,
  data?: unknown,
): void {
  const errorResponse: IJsonRpcResponse = {
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message: message,
    },
    id: id,
  };

  if (data !== undefined) {
    errorResponse.error!.data = data;
  }

  res.status(httpStatus).json(errorResponse);
}

/**
 * Parse a boolean value from request parameters.
 * Accepts: true, "true", 1, "1" as true
 * Accepts: false, "false", 0, "0", null, undefined as false
 */
export function parseBoolean(value: any): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  return false;
} 
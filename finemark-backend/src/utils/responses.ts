import { Response } from "express";

export const ok = (res: Response, data: unknown, message?: string) => {
  return res.status(200).json(message ? { data, message } : data);
};

export const created = (res: Response, data: unknown, message?: string) => {
  return res.status(201).json(message ? { data, message } : data);
};

export const errorResponse = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) => {
  return res.status(status).json({ error: { code, message, details } });
};

export const throwApiError = (status: number, code: string, message: string, details?: unknown) => {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  throw err;
};

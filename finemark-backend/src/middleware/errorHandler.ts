import { Request, Response, NextFunction } from "express";
import { errorResponse } from "../utils/responses.js";

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[errorHandler] ${req.method} ${req.path} →`, err?.message || err);
  if (err?.status && err?.code) {
    return errorResponse(res, err.status, err.code, err.message, err.details);
  }
  // express-rate-limit
  if (err?.status === 429) {
    return errorResponse(res, 429, "TOO_MANY_REQUESTS", "Too many requests. Please wait and try again.");
  }
  // body-parser PayloadTooLargeError
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return errorResponse(res, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.");
  }
  // CORS rejection
  if (err?.message?.startsWith("CORS:")) {
    return errorResponse(res, 403, "CORS_FORBIDDEN", err.message);
  }
  return errorResponse(res, 500, "SERVER_ERROR", err?.message || "Something went wrong.");
};

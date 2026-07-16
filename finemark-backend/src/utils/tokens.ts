import crypto from "crypto";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET environment variable is required and must be at least 32 characters.");
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";

export const signAccessToken = (payload: { sub: string; role: string; email: string; sid?: string }) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
};

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET) as { sub: string; role: string; email: string; sid?: string };
};

export const generateRefreshToken = () => {
  return crypto.randomBytes(32).toString("base64url");
};

export const hashRefreshToken = (token: string) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

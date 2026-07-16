import "dotenv/config";
import "express-async-errors";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import portalRoutes from "./routes/portal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = Number(process.env.PORT || 3001);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:"],
      fontSrc:    ["'self'"],
      connectSrc: ["'self'"],
    },
  },
}));

const CORS_ORIGINS = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));

// ── Serve portal static files ─────────────────────────────────────────────────
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// ── Explicit page routes (extension-less URLs) ────────────────────────────────
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(publicDir, "dashboard.html")));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "finemark-portal" }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api", portalRoutes);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[portal] Unhandled error:", err);
  res.status(err.status || 500).json({ ok: false, message: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[portal] Finemark Customer Portal running on http://localhost:${PORT}`);
});

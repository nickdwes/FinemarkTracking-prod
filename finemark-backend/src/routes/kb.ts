import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import path from "path";
import fs from "fs";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, errorResponse, created } from "../utils/responses.js";
import type { AuthRequest } from "../middleware/auth.js";

// ── Bootstrap ─────────────────────────────────────────────────────────────────
pgRun(`CREATE TABLE IF NOT EXISTS kb_articles (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'General',
  icon        TEXT DEFAULT '📄',
  summary     TEXT,
  sections_json TEXT NOT NULL DEFAULT '[]',
  published   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_by  TEXT,
  updated_by  TEXT
)`, []).catch(e => console.error("[kb_articles] init:", e));

pgRun(`CREATE TABLE IF NOT EXISTS kb_media (
  id           TEXT PRIMARY KEY,
  article_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  filename     TEXT,
  url          TEXT NOT NULL,
  thumbnail_url TEXT,
  caption      TEXT,
  is_cover     INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
)`, []).catch(e => console.error("[kb_media] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_kb_media_article ON kb_media(article_id)`, []).catch(() => {});

const WRITE_ROLES = ["Admin", "Technical"] as const;
const READ_ROLES  = ["Admin", "Technical", "InstallOffice", "Technician"] as const;

// ── Multer setup ──────────────────────────────────────────────────────────────
const ALLOWED_IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_VIDEO = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo"]);

const kbStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), "uploads", "kb");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".bin";
    cb(null, uuidv4() + ext);
  },
});

const kbUpload = multer({
  storage: kbStorage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB (videos can be large)
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE.has(file.mimetype) || ALLOWED_VIDEO.has(file.mimetype)) cb(null, true);
    else cb(new Error("Only images (jpg/png/webp/gif) and videos (mp4/webm/mov) are allowed."));
  },
}).single("file");

// ── Helpers ───────────────────────────────────────────────────────────────────
async function articleWithMedia(row: any) {
  const media = await pgAll(
    `SELECT * FROM kb_media WHERE article_id = ? ORDER BY is_cover DESC, sort_order ASC, created_at ASC`,
    [row.id]
  ).catch(() => [] as any[]);
  return {
    id:         row.id,
    title:      row.title,
    category:   row.category,
    icon:       row.icon || "📄",
    summary:    row.summary || "",
    sections:   (() => { try { return JSON.parse(row.sections_json || "[]"); } catch { return []; } })(),
    published:  row.published === 1,
    sortOrder:  row.sort_order || 0,
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
    createdBy:  row.created_by || null,
    updatedBy:  row.updated_by || null,
    media: media.map((m: any) => ({
      id:           m.id,
      type:         m.type,
      filename:     m.filename || null,
      url:          m.url,
      thumbnailUrl: m.thumbnail_url || null,
      caption:      m.caption || "",
      isCover:      m.is_cover === 1,
      sortOrder:    m.sort_order || 0,
    })),
  };
}

const router = Router();

// ── GET /   list articles ────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole([...READ_ROLES]), async (req: AuthRequest, res) => {
  const user = req.user!;
  const isWriter = WRITE_ROLES.includes(user.role as any);
  // Non-writers only see published articles
  const where = isWriter ? "" : "WHERE published = 1";
  const rows = await pgAll(
    `SELECT * FROM kb_articles ${where} ORDER BY sort_order ASC, updated_at DESC`, []
  ).catch(() => [] as any[]);

  const articles = await Promise.all(rows.map(articleWithMedia));
  return ok(res, articles);
});

// ── GET /:id  single article ─────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole([...READ_ROLES]), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT * FROM kb_articles WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Article not found.");
  const user = req.user!;
  const isWriter = WRITE_ROLES.includes(user.role as any);
  if (!isWriter && row.published !== 1)
    return errorResponse(res, 404, "NOT_FOUND", "Article not found.");
  return ok(res, await articleWithMedia(row));
});

// ── POST /   create article ──────────────────────────────────────────────────
router.post("/", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const { title, category, icon, summary, sections, published, sortOrder } = req.body || {};
  if (!title?.trim()) return errorResponse(res, 400, "VALIDATION", "Title is required.");

  const id  = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO kb_articles (id,title,category,icon,summary,sections_json,published,sort_order,created_at,updated_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, title.trim(), category || "General", icon || "📄",
     summary || "", JSON.stringify(sections || []),
     published ? 1 : 0, sortOrder || 0, now, now, req.user!.email || ""]
  );
  const row = await pgGet(`SELECT * FROM kb_articles WHERE id = ?`, [id]);
  return created(res, await articleWithMedia(row), "Article created");
});

// ── PUT /:id  update article ─────────────────────────────────────────────────
router.put("/:id", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM kb_articles WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Article not found.");

  const { title, category, icon, summary, sections, published, sortOrder } = req.body || {};
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at=?", "updated_by=?"];
  const vals: any[] = [now, req.user!.email || ""];

  if (title       !== undefined) { sets.push("title=?");         vals.push(title.trim()); }
  if (category    !== undefined) { sets.push("category=?");      vals.push(category); }
  if (icon        !== undefined) { sets.push("icon=?");          vals.push(icon); }
  if (summary     !== undefined) { sets.push("summary=?");       vals.push(summary); }
  if (sections    !== undefined) { sets.push("sections_json=?"); vals.push(JSON.stringify(sections)); }
  if (published   !== undefined) { sets.push("published=?");     vals.push(published ? 1 : 0); }
  if (sortOrder   !== undefined) { sets.push("sort_order=?");    vals.push(sortOrder); }

  vals.push(req.params.id);
  await pgRun(`UPDATE kb_articles SET ${sets.join(",")} WHERE id=?`, vals);
  const updated = await pgGet(`SELECT * FROM kb_articles WHERE id = ?`, [req.params.id]);
  return ok(res, await articleWithMedia(updated));
});

// ── DELETE /:id  delete article ───────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM kb_articles WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Article not found.");

  // Delete associated media files from disk
  const mediaRows = await pgAll(`SELECT filename FROM kb_media WHERE article_id = ?`, [req.params.id]).catch(() => []);
  for (const m of mediaRows) {
    if (m.filename) {
      const fpath = path.join(process.cwd(), "uploads", "kb", m.filename);
      fs.unlink(fpath, () => {});
    }
  }

  await pgRun(`DELETE FROM kb_media WHERE article_id = ?`, [req.params.id]);
  await pgRun(`DELETE FROM kb_articles WHERE id = ?`, [req.params.id]);
  return ok(res, { deleted: true });
});

// ── POST /:id/media  upload image or video ───────────────────────────────────
router.post("/:id/media", requireAuth, requireRole([...WRITE_ROLES]), (req, res, next) => {
  pgGet(`SELECT id FROM kb_articles WHERE id = ?`, [req.params.id]).then(row => {
    if (!row) { res.status(404).json({ error: { message: "Article not found." } }); return; }
    kbUpload(req, res, err => {
      if (err) { res.status(400).json({ error: { message: err.message } }); return; }
      next();
    });
  }).catch(next);
}, async (req: AuthRequest, res) => {
  if (!(req as any).file)
    return errorResponse(res, 400, "NO_FILE", "No file attached.");

  const f    = (req as any).file as Express.Multer.File;
  const type = ALLOWED_IMAGE.has(f.mimetype) ? "image" : "video";
  const url  = `/uploads/kb/${f.filename}`;
  const id   = uuidv4();
  const now  = new Date().toISOString();
  const { caption, isCover, sortOrder } = req.body || {};

  // If this is set as cover, unset any existing cover
  if (isCover === "true" || isCover === true) {
    await pgRun(`UPDATE kb_media SET is_cover=0 WHERE article_id=?`, [req.params.id]);
  }

  await pgRun(
    `INSERT INTO kb_media (id,article_id,type,filename,url,caption,is_cover,sort_order,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, req.params.id, type, f.filename, url,
     caption || "", (isCover === "true" || isCover === true) ? 1 : 0,
     Number(sortOrder) || 0, now]
  );
  return created(res, { id, type, url, filename: f.filename, caption: caption || "", isCover: !!(isCover), size: f.size }, "Media uploaded");
});

// ── POST /:id/media/url  add embed URL (YouTube/Vimeo/etc.) ─────────────────
router.post("/:id/media/url", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM kb_articles WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Article not found.");

  const { url, caption, thumbnailUrl, isCover, sortOrder } = req.body || {};
  if (!url?.trim()) return errorResponse(res, 400, "VALIDATION", "url is required.");

  if (isCover) await pgRun(`UPDATE kb_media SET is_cover=0 WHERE article_id=?`, [req.params.id]);

  const id  = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO kb_media (id,article_id,type,url,thumbnail_url,caption,is_cover,sort_order,created_at)
     VALUES (?,?,'video_url',?,?,?,?,?,?)`,
    [id, req.params.id, url.trim(), thumbnailUrl || null,
     caption || "", isCover ? 1 : 0, Number(sortOrder) || 0, now]
  );
  return created(res, { id, type: "video_url", url: url.trim(), caption: caption || "" }, "Video URL added");
});

// ── DELETE /:id/media/:mediaId  remove one media item ───────────────────────
router.delete("/:id/media/:mediaId", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const m = await pgGet(`SELECT * FROM kb_media WHERE id=? AND article_id=?`, [req.params.mediaId, req.params.id]);
  if (!m) return errorResponse(res, 404, "NOT_FOUND", "Media not found.");

  if (m.filename) {
    const fpath = path.join(process.cwd(), "uploads", "kb", m.filename);
    fs.unlink(fpath, () => {});
  }
  await pgRun(`DELETE FROM kb_media WHERE id=?`, [req.params.mediaId]);
  return ok(res, { deleted: true });
});

// ── PATCH /:id/media/:mediaId  update caption / cover / order ──────────────
router.patch("/:id/media/:mediaId", requireAuth, requireRole([...WRITE_ROLES]), async (req: AuthRequest, res) => {
  const m = await pgGet(`SELECT * FROM kb_media WHERE id=? AND article_id=?`, [req.params.mediaId, req.params.id]);
  if (!m) return errorResponse(res, 404, "NOT_FOUND", "Media not found.");

  const { caption, isCover, sortOrder } = req.body || {};
  if (isCover) await pgRun(`UPDATE kb_media SET is_cover=0 WHERE article_id=?`, [req.params.id]);

  const sets: string[] = [];
  const vals: any[]    = [];
  if (caption   !== undefined) { sets.push("caption=?");    vals.push(caption); }
  if (isCover   !== undefined) { sets.push("is_cover=?");   vals.push(isCover ? 1 : 0); }
  if (sortOrder !== undefined) { sets.push("sort_order=?"); vals.push(Number(sortOrder)); }

  if (sets.length) {
    vals.push(req.params.mediaId);
    await pgRun(`UPDATE kb_media SET ${sets.join(",")} WHERE id=?`, vals);
  }
  const updated = await pgGet(`SELECT * FROM kb_media WHERE id=?`, [req.params.mediaId]);
  return ok(res, { id: updated.id, caption: updated.caption, isCover: updated.is_cover === 1, sortOrder: updated.sort_order });
});

export default router;

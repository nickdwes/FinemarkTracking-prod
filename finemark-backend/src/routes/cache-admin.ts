import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok } from "../utils/responses.js";
import { cacheClear, cacheStats } from "../utils/cache.js";

const router = Router();

router.get("/stats", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (_req, res) => {
  return ok(res, cacheStats());
});

router.post("/clear", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (_req, res) => {
  const removed = cacheClear();
  return ok(res, { cleared: removed }, "Cache cleared");
});

export default router;

import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/authenticate.js";

const router = Router();
router.use(authenticate);

// GET /api/siren-search?q=...
// Proxy vers l'API Sirene publique — sans clé API, gratuite
router.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json({ results: [] });

  try {
    const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&per_page=6`;
    const apiRes = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "M7Sept/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!apiRes.ok) return res.json({ results: [] });
    const data = await apiRes.json() as { results?: unknown[] };
    return res.json({ results: data.results ?? [] });
  } catch {
    return res.json({ results: [] });
  }
});

export { router as sirenRouter };

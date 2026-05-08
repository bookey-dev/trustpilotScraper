const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const { scrapeData, toCSV } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 4008;
const SCRAPE_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_DATE_FILTER = "last30days";
const CMS_BATCH_URL = process.env.CMS_BATCH_URL || "https://cms.velliavey.com/prod-api/trustpilot_data/batch";
const scrapeCache = new Map();

app.use(express.json({ limit: "10mb" }));

function normalizeStarFilters(starFilters) {
  const values = Array.isArray(starFilters)
    ? starFilters
    : String(starFilters || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return [...new Set(
    values
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5)
  )].sort((a, b) => b - a);
}

function buildCacheKey(company, maxPages, dateFilter, starFilters) {
  return `${company}::${maxPages}::${dateFilter}::${starFilters.join(",")}`;
}

async function getScrapeDataCached(company, maxPages, dateFilter, starFilters) {
  const cacheKey = buildCacheKey(company, maxPages, dateFilter, starFilters);
  const cached = scrapeCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < SCRAPE_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await scrapeData(company, maxPages, dateFilter, undefined, starFilters);
  scrapeCache.set(cacheKey, { data, createdAt: now });
  return data;
}

// API: 抓取公司数据
app.get("/api/scrape", async (req, res) => {
  const company = (req.query.company || "").trim();
  const maxPages = parseInt(req.query.maxPages, 10) || DEFAULT_MAX_PAGES;
  const dateFilter = (req.query.date || DEFAULT_DATE_FILTER).trim();
  const starFilters = normalizeStarFilters(req.query.stars);

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    console.log(`[API] 开始抓取: ${company}, maxPages=${maxPages}, date=${dateFilter}, stars=${starFilters.join(",") || "all"}`);
    const data = await getScrapeDataCached(company, maxPages, dateFilter, starFilters);
    console.log(`[API] 完成: ${company}, ${data.totalReviews} 条评论`);
    res.json(data);
  } catch (err) {
    console.error(`[API] 失败: ${company}`, err.message);
    const statusCode = /HTTP 403\b/.test(err.message) ? 403 : 500;
    res.status(statusCode).json({ error: `抓取失败: ${err.message}` });
  }
});

// API: 下载 CSV
app.get("/api/download/csv", async (req, res) => {
  const company = (req.query.company || "").trim();
  const maxPages = parseInt(req.query.maxPages, 10) || DEFAULT_MAX_PAGES;
  const dateFilter = (req.query.date || DEFAULT_DATE_FILTER).trim();
  const starFilters = normalizeStarFilters(req.query.stars);

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    const data = await getScrapeDataCached(company, maxPages, dateFilter, starFilters);
    const csv = toCSV(data.reviews);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${company.replace(/\./g, "_")}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: `导出失败: ${err.message}` });
  }
});

// API: 下载 JSON
app.get("/api/download/json", async (req, res) => {
  const company = (req.query.company || "").trim();
  const maxPages = parseInt(req.query.maxPages, 10) || DEFAULT_MAX_PAGES;
  const dateFilter = (req.query.date || DEFAULT_DATE_FILTER).trim();
  const starFilters = normalizeStarFilters(req.query.stars);

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    const data = await getScrapeDataCached(company, maxPages, dateFilter, starFilters);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${company.replace(/\./g, "_")}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: `导出失败: ${err.message}` });
  }
});

app.post("/api/import/batch", async (req, res) => {
  const trustpilotDatas = Array.isArray(req.body) ? req.body : [];

  if (!trustpilotDatas.length) {
    return res.status(400).json({ error: "没有可导入的评论数据" });
  }

  try {
    const response = await fetch(CMS_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trustpilotDatas),
    });
    const text = await response.text();
    let payload;

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      payload = { raw: text };
    }

    if (!response.ok || payload?.success === false || payload?.failed === true) {
      return res.status(response.ok ? 502 : response.status).json({
        error: payload?.message || payload?.msg || `导入失败: HTTP ${response.status}`,
        upstream: payload,
      });
    }

    res.json({
      success: true,
      totalRows: trustpilotDatas.length,
      upstream: payload,
    });
  } catch (err) {
    res.status(500).json({ error: `导入失败: ${err.message}` });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n🚀 Trustpilot Scraper 已启动: http://localhost:${PORT}\n`);
});

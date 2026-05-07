const express = require("express");
const path = require("path");
const { scrapeData, toCSV } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 4008;
const SCRAPE_CACHE_TTL_MS = 10 * 60 * 1000;
const scrapeCache = new Map();

app.use(express.static(path.join(__dirname, "public")));

function buildCacheKey(company, maxPages, dateFilter) {
  return `${company}::${maxPages}::${dateFilter}`;
}

async function getScrapeDataCached(company, maxPages, dateFilter) {
  const cacheKey = buildCacheKey(company, maxPages, dateFilter);
  const cached = scrapeCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < SCRAPE_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await scrapeData(company, maxPages, dateFilter);
  scrapeCache.set(cacheKey, { data, createdAt: now });
  return data;
}

// API: 抓取公司数据
app.get("/api/scrape", async (req, res) => {
  const company = (req.query.company || "").trim();
  const maxPages = parseInt(req.query.maxPages) || 5;
  const dateFilter = (req.query.date || "all").trim();

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    console.log(`[API] 开始抓取: ${company}, maxPages=${maxPages}, date=${dateFilter}`);
    const data = await getScrapeDataCached(company, maxPages, dateFilter);
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
  const maxPages = parseInt(req.query.maxPages) || 5;
  const dateFilter = (req.query.date || "all").trim();

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    const data = await getScrapeDataCached(company, maxPages, dateFilter);
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
  const maxPages = parseInt(req.query.maxPages) || 5;
  const dateFilter = (req.query.date || "all").trim();

  if (!company) {
    return res.status(400).json({ error: "请提供 company 参数" });
  }

  try {
    const data = await getScrapeDataCached(company, maxPages, dateFilter);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${company.replace(/\./g, "_")}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: `导出失败: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Trustpilot Scraper 已启动: http://localhost:${PORT}\n`);
});

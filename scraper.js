const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VALID_DATE_FILTERS = new Set([
  "all",
  "last30days",
  "last3months",
  "last6months",
  "last12months",
]);
const DEFAULT_COMPANIES = [
  "www.velliavey.eu",
  "www.velliavey.ca",
  "www.velliavey.com.au",
  "www.velliavey.uk",
  "www.velliavey.com",
];

// ============ 配置 ============
const CONFIG = {
  // 支持逗号分隔多个公司域名，如: www.a.com,www.b.com,www.c.com
  companies: (process.argv[2] || DEFAULT_COMPANIES.join(",")).split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  // 抓取的最大页数，0 表示全部
  maxPages: parseInt(process.argv[3]) || 0,
  // 时间筛选
  dateFilter: process.argv[4] || "all",
  // 每次请求间隔（毫秒），避免被封
  delay: 1500,
  // 输出格式: json / csv / both
  outputFormat: "both",
};

const BASE_URL = "https://www.trustpilot.com/review";
const BASE_ORIGIN = "https://www.trustpilot.com";

function normalizeDateFilter(dateFilter) {
  return VALID_DATE_FILTERS.has(dateFilter) ? dateFilter : "all";
}

function buildReviewUrl(company, pageNumber, dateFilter = "all") {
  const url = new URL(`${BASE_URL}/${company}`);
  const normalizedDateFilter = normalizeDateFilter(dateFilter);
  if (pageNumber > 1) {
    url.searchParams.set("page", String(pageNumber));
  }
  if (normalizedDateFilter !== "all") {
    url.searchParams.set("date", normalizedDateFilter);
  }
  return url.toString();
}

function summarizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createBrowserSession() {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1440, height: 900 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(45000);

  return { browser, context, page };
}

async function fetchPageWithBrowser(page, company, pageNumber, dateFilter = "all") {
  const url = buildReviewUrl(company, pageNumber, dateFilter);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(2500);

      const html = await page.content();

      if (/Verifying your connection|Verification failed|Please wait while we verify your browser/i.test(html)) {
        throw new Error(`浏览器验证未通过 | 响应摘要: ${summarizeHtml(html)}`);
      }

      if (!response) {
        throw new Error("页面未返回响应对象");
      }

      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()} for page ${pageNumber} | 响应摘要: ${summarizeHtml(html)}`);
      }

      if (!html.includes('__NEXT_DATA__')) {
        throw new Error(`页面缺少 __NEXT_DATA__ | 响应摘要: ${summarizeHtml(html)}`);
      }

      return html;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(2500 * attempt);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
    }
  }

  throw lastError;
}

function extractNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error("无法找到 __NEXT_DATA__");
  return JSON.parse(match[1]);
}

function parseBusinessInfo(businessUnit) {
  return {
    name: businessUnit.displayName,
    domain: businessUnit.identifyingName,
    trustScore: businessUnit.trustScore,
    stars: businessUnit.stars,
    numberOfReviews: businessUnit.numberOfReviews,
    websiteUrl: businessUnit.websiteUrl,
    categories: (businessUnit.categories || []).map((c) => c?.displayName).filter(Boolean),
    contactEmail: businessUnit.contactEmail || null,
    contactPhone: businessUnit.phone || null,
    address: businessUnit.address
      ? [businessUnit.address.street, businessUnit.address.city, businessUnit.address.zipCode, businessUnit.address.country].filter(Boolean).join(", ")
      : null,
    isClaimed: businessUnit.isClaimed || false,
  };
}

function parseStarDistribution(pageProps) {
  const ratings = pageProps.filters?.reviewStatistics?.ratings;
  if (!ratings) return null;
  return {
    "5 星": ratings.five,
    "4 星": ratings.four,
    "3 星": ratings.three,
    "2 星": ratings.two,
    "1 星": ratings.one,
    "总计": ratings.total,
  };
}

function parseLanguageDistribution(pageProps) {
  const langs = pageProps.filters?.reviewStatistics?.reviewLanguages;
  if (!langs) return null;
  return langs
    .filter((l) => l.isoCode !== "all")
    .map((l) => ({ language: l.displayName, code: l.isoCode, count: l.reviewCount }))
    .sort((a, b) => b.count - a.count);
}

function parseOverviewData(pageProps) {
  const overview = {};

  // AI 摘要
  if (pageProps.aiSummary) {
    overview.aiSummary = pageProps.aiSummary.summary || pageProps.aiSummary;
  }

  // 主题 AI 摘要
  if (pageProps.topicAiSummaries && Array.isArray(pageProps.topicAiSummaries)) {
    overview.topicSummaries = pageProps.topicAiSummaries.map((t) => ({
      topic: t.topic || t.topicName,
      summary: t.summary,
      sentiment: t.sentiment,
    }));
  }

  // 筛选器中的分页统计
  if (pageProps.filters?.pagination) {
    overview.pagination = {
      totalReviewsFiltered: pageProps.filters.pagination.totalCount,
      totalPages: pageProps.filters.pagination.totalPages,
      perPage: pageProps.filters.pagination.perPage,
    };
  }

  return overview;
}

function parseReview(review) {
  return {
    id: review.id,
    title: review.title,
    text: review.text,
    rating: review.rating,
    language: review.language,
    publishedDate: review.dates?.publishedDate,
    experiencedDate: review.dates?.experiencedDate,
    consumerName: review.consumer?.displayName,
    consumerAvatar: review.consumer?.imageUrl || "",
    consumerCountry: review.consumer?.countryCode,
    consumerReviewCount: review.consumer?.numberOfReviews,
    isVerified: review.labels?.verification?.isVerified || false,
    verificationSource: review.labels?.verification?.verificationSource,
    source: review.source,
    replyText: review.reply?.message || null,
    replyDate: review.reply?.publishedDate || null,
    likes: review.likes || 0,
  };
}

function toCSV(reviews) {
  if (reviews.length === 0) return "";
  const headers = Object.keys(reviews[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val).replace(/"/g, '""');
    return str.includes(",") || str.includes('"') || str.includes("\n")
      ? `"${str}"`
      : str;
  };
  const rows = reviews.map((r) => headers.map((h) => escape(r[h])).join(","));
  return [headers.join(","), ...rows].join("\n");
}

async function scrape(company) {
  const { maxPages, delay, outputFormat } = CONFIG;
  const dateFilter = normalizeDateFilter(CONFIG.dateFilter);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔍 开始抓取: ${company}`);
  console.log(`   URL: ${buildReviewUrl(company, 1, dateFilter)}`);
  console.log(`   时间范围: ${dateFilter}\n`);

  const session = await createBrowserSession();

  try {
    // 第一页：获取总页数 + 公司信息
    const firstHtml = await fetchPageWithBrowser(session.page, company, 1, dateFilter);
    const firstData = extractNextData(firstHtml);
    const pageProps = firstData.props.pageProps;

    const businessInfo = parseBusinessInfo(pageProps.businessUnit);
    const starDistribution = parseStarDistribution(pageProps);
    const languageDistribution = parseLanguageDistribution(pageProps);
    const overviewData = parseOverviewData(pageProps);

    console.log(`📊 公司: ${businessInfo.name}`);
    console.log(`   网站: ${businessInfo.websiteUrl || businessInfo.domain}`);
    console.log(`   地址: ${businessInfo.address || "N/A"}`);
    console.log(`   评分: ${businessInfo.trustScore} / 5 (${businessInfo.stars} 星)`);
    console.log(`   总评论数: ${businessInfo.numberOfReviews}`);
    console.log(`   认领状态: ${businessInfo.isClaimed ? "已认领" : "未认领"}`);

    if (starDistribution) {
      const total = starDistribution["总计"] || businessInfo.numberOfReviews;
      console.log(`\n⭐ 星级分布:`);
      for (const [star, count] of Object.entries(starDistribution)) {
        if (star === "总计") continue;
        const pct = ((count / total) * 100).toFixed(1);
        const bar = "█".repeat(Math.round(pct / 2));
        console.log(`   ${star}: ${count} (${pct}%) ${bar}`);
      }
      console.log(`   总计: ${total}`);
    }

    if (languageDistribution?.length) {
      console.log(`\n🌍 语言分布:`);
      for (const l of languageDistribution) {
        console.log(`   ${l.language} (${l.code}): ${l.count} 条`);
      }
    }

    if (overviewData.aiSummary) {
      const summary = typeof overviewData.aiSummary === "string"
        ? overviewData.aiSummary
        : overviewData.aiSummary.text || JSON.stringify(overviewData.aiSummary);
      console.log(`\n🤖 AI 摘要: ${summary}`);
    }

    if (overviewData.topicSummaries?.length) {
      console.log(`\n📌 主题摘要:`);
      for (const t of overviewData.topicSummaries) {
        console.log(`   [${t.sentiment || "N/A"}] ${t.topic}: ${t.summary}`);
      }
    }

    const totalPages = pageProps.filters?.pagination?.totalPages || 1;
    const pagesToScrape = maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages;
    console.log(`   总页数: ${totalPages}，计划抓取: ${pagesToScrape} 页\n`);

    // 收集第一页的评论
    const allReviews = (pageProps.reviews || []).map(parseReview);
    console.log(`✅ 第 1/${pagesToScrape} 页 - 获取 ${pageProps.reviews?.length || 0} 条评论`);

    // 抓取剩余页面
    for (let page = 2; page <= pagesToScrape; page++) {
      await sleep(delay);
      try {
        const html = await fetchPageWithBrowser(session.page, company, page, dateFilter);
        const data = extractNextData(html);
        const reviews = (data.props.pageProps.reviews || []).map(parseReview);
        allReviews.push(...reviews);
        console.log(`✅ 第 ${page}/${pagesToScrape} 页 - 获取 ${reviews.length} 条评论 (累计: ${allReviews.length})`);
      } catch (err) {
        console.error(`❌ 第 ${page} 页失败: ${err.message}`);
      }
    }

    // 输出结果
    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const timestamp = new Date().toISOString().slice(0, 10);
    const baseName = `${company.replace(/\./g, "_")}_${timestamp}`;

    if (outputFormat === "json" || outputFormat === "both") {
      const jsonPath = path.join(outputDir, `${baseName}.json`);
      const output = { businessInfo, starDistribution, languageDistribution, overviewData, scrapedAt: new Date().toISOString(), dateFilter, totalReviews: allReviews.length, reviews: allReviews };
      fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`\n📁 JSON 已保存: ${jsonPath}`);
    }

    if (outputFormat === "csv" || outputFormat === "both") {
      const csvPath = path.join(outputDir, `${baseName}.csv`);
      fs.writeFileSync(csvPath, toCSV(allReviews), "utf-8");
      console.log(`📁 CSV 已保存: ${csvPath}`);
    }

    console.log(`\n🎉 完成！共抓取 ${allReviews.length} 条评论\n`);
  } finally {
    await session.browser.close();
  }
}

// 纯数据抓取，返回结构化结果（供 Web 服务调用）
async function scrapeData(company, maxPages = 0, dateFilter = "all", onProgress) {
  const delay = 1500;
  const normalizedDateFilter = normalizeDateFilter(dateFilter);
  const session = await createBrowserSession();

  try {
    const firstHtml = await fetchPageWithBrowser(session.page, company, 1, normalizedDateFilter);
    const firstData = extractNextData(firstHtml);
    const pageProps = firstData.props.pageProps;

    const businessInfo = parseBusinessInfo(pageProps.businessUnit);
    const starDistribution = parseStarDistribution(pageProps);
    const languageDistribution = parseLanguageDistribution(pageProps);
    const overviewData = parseOverviewData(pageProps);

    const totalPages = pageProps.filters?.pagination?.totalPages || 1;
    const pagesToScrape = maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages;

    const allReviews = (pageProps.reviews || []).map(parseReview);
    if (onProgress) onProgress(1, pagesToScrape, allReviews.length);

    for (let page = 2; page <= pagesToScrape; page++) {
      await sleep(delay);
      try {
        const html = await fetchPageWithBrowser(session.page, company, page, normalizedDateFilter);
        const data = extractNextData(html);
        const reviews = (data.props.pageProps.reviews || []).map(parseReview);
        allReviews.push(...reviews);
        if (onProgress) onProgress(page, pagesToScrape, allReviews.length);
      } catch (_) {}
    }

    return {
      businessInfo,
      starDistribution,
      languageDistribution,
      overviewData,
      scrapedAt: new Date().toISOString(),
      dateFilter: normalizedDateFilter,
      totalPages,
      pagesToScrape,
      totalReviews: allReviews.length,
      reviews: allReviews,
    };
  } finally {
    await session.browser.close();
  }
}

module.exports = { scrapeData, toCSV };

// 仅在直接运行时执行 CLI 模式
if (require.main === module) {
  async function main() {
    const { companies } = CONFIG;
    console.log(`\n📋 共 ${companies.length} 个公司待抓取: ${companies.join(", ")}`);

    const results = [];
    for (const company of companies) {
      try {
        await scrape(company);
        results.push({ company, status: "✅ 成功" });
      } catch (err) {
        console.error(`\n❌ ${company} 抓取失败: ${err.message}\n`);
        results.push({ company, status: `❌ 失败: ${err.message}` });
      }
    }

    if (companies.length > 1) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`📋 汇总:`);
      for (const r of results) {
        console.log(`   ${r.status} - ${r.company}`);
      }
      console.log();
    }
  }

  main().catch((err) => {
    console.error("抓取失败:", err.message);
    process.exit(1);
  });
}

# trustpilotScraper

一个基于 `Node.js + Express + Playwright` 的 Trustpilot 评论抓取工具，支持：

- Web 页面输入公司域名并查看抓取结果
- 命令行批量抓取多个站点
- 导出 `JSON` 和 `CSV`
- 按时间范围筛选评论
- 展示公司概览、星级分布、语言分布和评论列表

适合做竞品调研、用户反馈收集、评论分析和数据导出。

## 功能特性

- 支持抓取单个或多个公司域名
- 支持时间筛选：
  - `all`
  - `last30days`
  - `last3months`
  - `last6months`
  - `last12months`
- 支持限制抓取页数，也支持抓取全部页面
- 自动解析 Trustpilot 页面中的结构化数据
- 支持导出为 CSV / JSON
- Web 端内置简单缓存，避免短时间重复抓取同一数据

## 项目结构

```text
trustpilotScraper/
├── public/
│   └── index.html      # Web 界面
├── output/             # CLI 抓取输出目录
├── scraper.js          # Playwright 抓取核心逻辑
├── server.js           # Express 服务和下载接口
├── package.json
└── README.md
```

## 运行环境

- Node.js 18+
- npm 9+
- macOS / Linux / Windows

说明：

- 项目依赖 `playwright`
- 在部分环境中，首次运行可能需要安装浏览器依赖
- 当前代码优先尝试使用本机 Chrome：
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

如果你的机器没有这个路径，Playwright 会回退到默认浏览器配置。

## 安装

```bash
npm install
```

如果 Playwright 浏览器未安装完整，可额外执行：

```bash
npx playwright install
```

## 启动 Web 界面

```bash
npm run dev
```

启动后访问：

```text
http://localhost:4008
```

默认端口来自 [server.js](/Users/lijun/GitHub/trustpilotScraper/server.js:6)，可通过环境变量覆盖：

```bash
PORT=4008 npm run dev
```

## Web 使用方式

在页面中可以：

- 输入一个公司域名，例如 `www.amazon.com`
- 也可以输入多个域名，用英文逗号或中文逗号分隔
- 选择抓取页数
- 选择评论时间范围
- 点击“开始抓取”
- 抓取完成后下载 CSV 或 JSON

默认示例值：

```text
www.velliavey.eu,www.velliavey.ca,www.velliavey.com.au,www.velliavey.uk,www.velliavey.com
```

## 命令行使用

项目也支持直接从命令行抓取。

### 基本命令

```bash
npm run scrape
```

### 指定公司

```bash
node scraper.js www.amazon.com
```

### 指定多个公司

```bash
node scraper.js www.amazon.com,www.ebay.com,www.walmart.com
```

### 指定最大页数

```bash
node scraper.js www.amazon.com 5
```

### 指定时间筛选

```bash
node scraper.js www.amazon.com 5 last3months
```

### 参数说明

```bash
node scraper.js <companies> <maxPages> <dateFilter>
```

- `companies`：公司域名，支持多个，用逗号分隔
- `maxPages`：最大抓取页数，`0` 表示抓取全部
- `dateFilter`：评论时间筛选，默认 `all`

示例：

```bash
node scraper.js www.amazon.com,www.ebay.com 10 last30days
```

## 输出结果

CLI 模式下，抓取结果会写入 `output/` 目录。

输出文件名格式：

```text
{company}_{YYYY-MM-DD}.json
{company}_{YYYY-MM-DD}.csv
```

例如：

```text
www_amazon_com_2026-05-07.json
www_amazon_com_2026-05-07.csv
```

## API 接口

### 1. 抓取数据

```http
GET /api/scrape
```

参数：

- `company`：必填，公司域名
- `maxPages`：可选，默认 `5`
- `date`：可选，默认 `all`

示例：

```text
/api/scrape?company=www.amazon.com&maxPages=3&date=last30days
```

### 2. 下载 CSV

```http
GET /api/download/csv
```

示例：

```text
/api/download/csv?company=www.amazon.com&maxPages=3&date=last30days
```

### 3. 下载 JSON

```http
GET /api/download/json
```

示例：

```text
/api/download/json?company=www.amazon.com&maxPages=3&date=last30days
```

## 返回数据示例

`/api/scrape` 返回结构大致如下：

```json
{
  "businessInfo": {
    "name": "Example",
    "domain": "www.example.com",
    "trustScore": 3.9,
    "stars": 4,
    "numberOfReviews": 1234
  },
  "starDistribution": {
    "5 星": 800,
    "4 星": 120,
    "3 星": 80,
    "2 星": 60,
    "1 星": 174,
    "总计": 1234
  },
  "languageDistribution": [
    {
      "language": "English",
      "code": "en",
      "count": 1100
    }
  ],
  "overviewData": {
    "pagination": {
      "totalReviewsFiltered": 1234,
      "totalPages": 62,
      "perPage": 20
    }
  },
  "scrapedAt": "2026-05-07T00:00:00.000Z",
  "dateFilter": "all",
  "totalPages": 62,
  "pagesToScrape": 5,
  "totalReviews": 100,
  "reviews": []
}
```

## 评论字段说明

每条评论主要包含：

- `id`
- `title`
- `text`
- `rating`
- `language`
- `publishedDate`
- `experiencedDate`
- `consumerName`
- `consumerCountry`
- `consumerReviewCount`
- `isVerified`
- `verificationSource`
- `replyText`
- `replyDate`
- `likes`

## 缓存机制

Web 服务中对相同参数的抓取结果做了简单内存缓存：

- 缓存时间：10 分钟
- 缓存键：`company + maxPages + dateFilter`

对应实现可见 [server.js](/Users/lijun/GitHub/trustpilotScraper/server.js:6)。

## 注意事项

- 抓取目标站点可能有反爬策略，偶尔会触发浏览器验证或 403
- 抓取大量页面时速度会受网络和页面加载影响
- 多公司并发抓取可能增加被限制的概率
- Trustpilot 页面结构如果变化，解析逻辑可能需要同步调整

## 常见问题

### 1. 运行时报浏览器相关错误

先执行：

```bash
npx playwright install
```

### 2. 返回 403 或验证页面

这通常是目标站点触发了风控。可以尝试：

- 减少并发或降低抓取频率
- 限制抓取页数
- 稍后重试
- 使用更稳定的网络环境

### 3. 没有生成输出文件

只有 CLI 模式会写入 `output/` 目录。  
Web 模式默认通过页面展示数据，并提供下载接口。

## 开发命令

```bash
npm run dev
npm run scrape
```

## 后续可扩展方向

- 增加代理支持
- 增加登录态 / Cookie 支持
- 增加抓取进度实时推送
- 增加数据库存储
- 增加关键词过滤和情感分析
- 增加 Docker 部署

## License

当前仓库未单独附带 License 文件，默认按仓库所有者策略使用。

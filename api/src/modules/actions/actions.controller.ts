import { CDPService } from "../../services/cdp/cdp.service.js";
import { FastifyReply } from "fastify";
import { getErrors } from "../../utils/errors.js";
import { PDFRequest, ScrapeRequest, ScreenshotRequest } from "./actions.schema.js";
import { cleanHtml, getMarkdown, getReadabilityContent } from "../../utils/scrape.js";
import { ScrapeFormat } from "../../types/index.js";
import { BrowserContext, Page } from "puppeteer-core";
import { updateLog } from "../../utils/logging.js";
import { IProxyServer } from "../../utils/proxy.js";
import { SessionService } from "../../services/session.service.js";

export const handleScrape = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: ScrapeRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, format, screenshot, pdf, proxyUrl, logUrl, delay } = request.body;

  let proxy: IProxyServer | null = null;
  let context: BrowserContext | null = null;

  try {
    if (proxyUrl) {
      proxy = await sessionService.proxyFactory(proxyUrl);
      await proxy.listen();
    }

    times.proxyTime = Date.now() - startTime;

    let page: Page;

    if (!browserService.isRunning()) {
      await browserService.launch();
    }

    if (proxy) {
      context = await browserService.createBrowserContext(proxy.url);
      page = await context.newPage();
      times.proxyPageTime = Date.now() - startTime - times.proxyTime;
    } else {
      page = await browserService.getPrimaryPage();
      times.pageTime = Date.now() - startTime - times.proxyTime;
    }

    if (url) {
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
      times.pageLoadTime = Date.now() - startTime - times.pageTime;
    }

    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    let scrapeResponse: Record<string, any> = { content: {} };

    const [{ html, metadata, links }, base64Screenshot, pdfBuffer] = await Promise.all([
      page.evaluate(() => {
        const getMetaContent = (name: string) => {
          const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
          return element ? element.getAttribute("content") : null;
        };

        return {
          html: document.documentElement.outerHTML,
          links: [...document.links].map((l) => ({ url: l.href, text: l.textContent })),
          metadata: {
            title: document.title,
            ogImage: getMetaContent("og:image") || undefined,
            ogTitle: getMetaContent("og:title") || undefined,
            urlSource: window.location.href,
            description: getMetaContent("description") || undefined,
            ogDescription: getMetaContent("og:description") || undefined,
            statusCode: 200, // This will always be 200 if the page loaded successfully
            language: document.documentElement.lang,
            timestamp: new Date().toISOString(),
            published_timestamp: getMetaContent("article:published_time") || undefined,
          },
        };
      }),
      screenshot ? page.screenshot({ encoding: "base64", type: "jpeg", quality: 100 }) : null,
      pdf ? page.pdf() : null,
    ]);

    times.extractionTime = Date.now() - startTime - times.pageLoadTime;

    scrapeResponse.metadata = metadata;
    scrapeResponse.links = links;

    if (format && format.length > 0) {
      if (format.includes(ScrapeFormat.HTML)) {
        scrapeResponse.content.html = html;
      }
      if (format.includes(ScrapeFormat.READABILITY)) {
        scrapeResponse.content.readability = getReadabilityContent(html);
        times.readabilityTime = Date.now() - startTime - times.extractionTime;
      }
      if (format.includes(ScrapeFormat.CLEANED_HTML)) {
        scrapeResponse.content.cleaned_html = cleanHtml(html);
        times.cleanedHtmlTime =
          (Date.now() - times.readabilityTime || Date.now() - times.extractionTime) - startTime;
      }
      if (format.includes(ScrapeFormat.MARKDOWN)) {
        const readabilityContent =
          scrapeResponse.content.readability ?? getReadabilityContent(html);
        scrapeResponse.content.markdown = getMarkdown(
          readabilityContent ? readabilityContent?.content : html,
        );
        times.markdownTime =
          (Date.now() - times.cleanedHtmlTime ||
            Date.now() - times.readabilityTime ||
            Date.now() - times.extractionTime) - startTime;
      }
    } else {
      scrapeResponse.content.html = html;
    }

    if (base64Screenshot) {
      scrapeResponse.screenshot = base64Screenshot;
    }
    if (pdfBuffer) {
      const base64Pdf = Buffer.from(pdfBuffer).toString("base64");
      scrapeResponse.pdf = base64Pdf;
    }

    times.totalInstanceTime = Date.now() - startTime;

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(scrapeResponse);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    if (url) {
      await browserService.refreshPrimaryPage();
    }
    return reply.code(500).send({ message: error });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (proxy) {
      await proxy.close(true).catch(() => {});
    }
  }
};

export const handleScreenshot = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: ScreenshotRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, logUrl, proxyUrl, delay, fullPage } = request.body;

  let proxy: IProxyServer | null = null;
  let context: BrowserContext | null = null;

  if (!browserService.isRunning()) {
    await browserService.launch();
  }

  try {
    if (proxyUrl) {
      proxy = await sessionService.proxyFactory(proxyUrl);
      await proxy.listen();
    }

    times.proxyTime = Date.now() - startTime;

    let page: Page;

    if (proxy) {
      context = await browserService.createBrowserContext(proxy.url);
      page = await context.newPage();
      times.proxyPageTime = Date.now() - startTime - times.proxyTime;
    } else {
      page = await browserService.getPrimaryPage();
      times.pageTime = Date.now() - startTime;
    }

    if (url) {
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
      times.pageLoadTime = Date.now() - times.pageTime - times.proxyTime - startTime;
    }

    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const screenshot = await page.screenshot({ fullPage, type: "jpeg", quality: 100 });
    times.screenshotTime =
      Date.now() - times.pageLoadTime - times.pageTime - times.proxyTime - startTime;

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(screenshot);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    if (url) {
      await browserService.refreshPrimaryPage();
    }

    return reply.code(500).send({ message: error });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (proxy) {
      await proxy.close(true).catch(() => {});
    }
  }
};

export const handlePDF = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: PDFRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, logUrl, proxyUrl, delay } = request.body;

  let proxy: IProxyServer | null = null;
  let context: BrowserContext | null = null;

  if (!browserService.isRunning()) {
    await browserService.launch();
  }

  try {
    if (proxyUrl) {
      proxy = await sessionService.proxyFactory(proxyUrl);
      await proxy.listen();
    }

    times.proxyTime = Date.now() - startTime;

    let page: Page;

    if (proxy) {
      context = await browserService.createBrowserContext(proxy.url);
      page = await context.newPage();
      times.proxyPageTime = Date.now() - startTime - times.proxyTime;
    } else {
      page = await browserService.getPrimaryPage();
      times.pageTime = Date.now() - startTime;
    }

    if (url) {
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
      times.pageLoadTime = Date.now() - times.pageTime - times.proxyTime - startTime;
    }

    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const pdf = await page.pdf();
    times.pdfTime = Date.now() - times.pageLoadTime - times.pageTime - times.proxyTime - startTime;

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(pdf);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    if (url) {
      await browserService.refreshPrimaryPage();
    }

    return reply.code(500).send({ message: error });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (proxy) {
      await proxy.close(true).catch(() => {});
    }
  }
};

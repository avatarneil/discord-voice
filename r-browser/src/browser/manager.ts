import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { BrowserContext, Page, Browser } from "playwright";
import * as path from "path";
import * as fs from "fs";

// Apply stealth plugin
chromium.use(stealthPlugin());

export interface BrowserConfig {
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;

  constructor(config: BrowserConfig = {}) {
    this.config = {
      executablePath: process.env.R_BROWSER_BIN,
      userDataDir: process.env.R_BROWSER_PROFILE,
      headless: process.env.HEADLESS === "true",
      ...config,
    };
  }

  async init(): Promise<void> {
    if (this.context) return;

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: this.config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    };

    if (this.config.executablePath) {
      launchOptions.executablePath = this.config.executablePath;
    }

    if (this.config.userDataDir) {
      const userDataDir = path.resolve(this.config.userDataDir);
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }

      console.error(`Launching persistent context with user data dir: ${userDataDir}`);
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } else {
      console.error("Launching ephemeral browser context");
      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext();
    }

    this.page = await this.context.newPage();

    // Set default viewport
    await this.page.setViewportSize({ width: 1280, height: 800 });
  }

  async getPage(): Promise<Page> {
    if (!this.page) {
      await this.init();
    }
    return this.page!;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.page = null;
  }
}

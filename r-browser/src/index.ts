import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserManager } from "./browser/manager.js";
import { Humanizer } from "./browser/humanizer.js";
import { DOMProcessor } from "./browser/dom.js";

class RBrowserServer {
  private server: Server;
  private browser: BrowserManager;
  private humanizer: Humanizer | null = null;
  private dom: DOMProcessor | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "r-browser",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.browser = new BrowserManager();

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (!request.params.arguments) {
          throw new Error("No arguments provided");
        }
        return await this.handleToolCall(request.params.name, request.params.arguments);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getTools(): Tool[] {
    return [
      {
        name: "browser_navigate",
        description: "Navigate to a URL with human-like behavior",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
      },
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page",
        inputSchema: {
          type: "object",
          properties: {
            full_page: { type: "boolean", default: false },
          },
        },
      },
      {
        name: "browser_get_dom",
        description: "Get a simplified, semantic JSON snapshot of the DOM",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Optional root selector" },
          },
        },
      },
      {
        name: "browser_click",
        description: "Click an element human-like",
        inputSchema: {
          type: "object",
          properties: {
            element_id: { type: "string", description: "The ID from browser_get_dom" },
            selector: { type: "string", description: "CSS selector" },
            coordinates: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] coordinates",
            },
          },
        },
      },
      {
        name: "browser_type",
        description: "Type text human-like",
        inputSchema: {
          type: "object",
          properties: {
            element_id: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            submit: { type: "boolean", default: false },
          },
          required: ["text"],
        },
      },
      {
        name: "browser_scroll",
        description: "Scroll the viewport",
        inputSchema: {
          type: "object",
          properties: {
            delta_x: { type: "number", default: 0 },
            delta_y: { type: "number", default: 0 },
          },
          required: ["delta_y"],
        },
      },
      {
        name: "browser_evaluate",
        description: "Execute JavaScript in the page",
        inputSchema: {
          type: "object",
          properties: {
            script: { type: "string" },
          },
          required: ["script"],
        },
      },
    ];
  }

  private async ensureInitialized() {
    const page = await this.browser.getPage();
    if (!this.humanizer) {
      this.humanizer = new Humanizer(page);
    }
    if (!this.dom) {
      this.dom = new DOMProcessor(page);
    }
    return page;
  }

  private async handleToolCall(name: string, args: unknown): Promise<CallToolResult> {
    const page = await this.ensureInitialized();

    switch (name) {
      case "browser_navigate": {
        const { url } = z.object({ url: z.string() }).parse(args);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return {
          content: [{ type: "text", text: `Navigated to ${url}` }],
        };
      }

      case "browser_screenshot": {
        const { full_page } = z.object({ full_page: z.boolean().optional() }).parse(args);
        const screenshot = await page.screenshot({ fullPage: full_page, type: "jpeg", quality: 80 });
        return {
          content: [
            {
              type: "image",
              data: screenshot.toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        };
      }

      case "browser_get_dom": {
        const { selector } = z.object({ selector: z.string().optional() }).parse(args);
        const snapshot = await this.dom!.getSnapshot(selector);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        };
      }

      case "browser_click": {
        const schema = z.object({
          element_id: z.string().optional(),
          selector: z.string().optional(),
          coordinates: z.tuple([z.number(), z.number()]).optional(),
        });
        const { element_id, selector, coordinates } = schema.parse(args);

        if (element_id) {
          const handle = await this.dom!.getElementById(element_id);
          if (!handle) throw new Error(`Element ${element_id} not found`);
          const box = await handle.boundingBox();
          if (box) {
            await this.humanizer!.click(`[data-r-browser-id="${element_id}"]`);
          }
        } else if (selector) {
          await this.humanizer!.click(selector);
        } else if (coordinates) {
          await page.mouse.click(coordinates[0], coordinates[1]);
        } else {
          throw new Error("Must provide element_id, selector, or coordinates");
        }

        return { content: [{ type: "text", text: "Clicked" }] };
      }

      case "browser_type": {
        const schema = z.object({
          element_id: z.string().optional(),
          selector: z.string().optional(),
          text: z.string(),
          submit: z.boolean().optional(),
        });
        const { element_id, selector, text, submit } = schema.parse(args);

        let targetSelector = selector;
        if (element_id) {
          targetSelector = `[data-r-browser-id="${element_id}"]`;
        }

        if (!targetSelector) throw new Error("Must provide element_id or selector for typing");

        await this.humanizer!.type(targetSelector, text);

        if (submit) {
          await page.keyboard.press("Enter");
        }

        return { content: [{ type: "text", text: `Typed "${text}"` }] };
      }

      case "browser_scroll": {
        const { delta_x, delta_y } = z.object({ delta_x: z.number().default(0), delta_y: z.number() }).parse(args);
        await this.humanizer!.scroll(delta_x, delta_y);
        return { content: [{ type: "text", text: "Scrolled" }] };
      }

      case "browser_evaluate": {
        const { script } = z.object({ script: z.string() }).parse(args);
        const result = await page.evaluate(script);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("R-Browser MCP server running on stdio");
  }
}

const server = new RBrowserServer();
server.run().catch(console.error);

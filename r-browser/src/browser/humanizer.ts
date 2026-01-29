import { Page } from "playwright";
import { createCursor, GhostCursor } from "ghost-cursor";

export class Humanizer {
  private cursor: GhostCursor | null = null;
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private async getCursor(): Promise<GhostCursor> {
    if (!this.cursor) {
      this.cursor = await createCursor(this.page);
    }
    return this.cursor;
  }

  async click(selector: string): Promise<void> {
    const cursor = await this.getCursor();
    await cursor.click(selector);
  }

  async move(selector: string): Promise<void> {
    const cursor = await this.getCursor();
    await cursor.move(selector);
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    // Human-like typing with variable delays and occasional errors
    // Since ghost-cursor focuses on mouse, we implement custom typing logic here
    // or use page.type if it's sufficient, but we want realistic delays.

    await this.click(selector);

    for (const char of text) {
      // Gaussian random delay
      const delay = Math.floor(Math.random() * 100) + 50; // Base delay 50-150ms

      // Occasional "mistake" logic (1% chance)
      if (Math.random() < 0.01) {
        const wrongChar = String.fromCharCode(char.charCodeAt(0) + 1);
        await this.page.keyboard.type(wrongChar, { delay: delay / 2 });
        await this.page.waitForTimeout(Math.floor(Math.random() * 200) + 100);
        await this.page.keyboard.press("Backspace");
        await this.page.waitForTimeout(Math.floor(Math.random() * 100) + 50);
      }

      await this.page.keyboard.type(char, { delay });
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.page.mouse.wheel(deltaX, deltaY);
  }
}

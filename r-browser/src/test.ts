import { BrowserManager } from "./browser/manager.js";
import { Humanizer } from "./browser/humanizer.js";
import { DOMProcessor } from "./browser/dom.js";

async function runTest() {
  const manager = new BrowserManager({ headless: true });

  try {
    console.log("Initializing browser...");
    await manager.init();
    const page = await manager.getPage();

    console.log("Navigating to example.com...");
    await page.goto("https://example.com");

    const humanizer = new Humanizer(page);
    const domProcessor = new DOMProcessor(page);

    console.log("Getting DOM snapshot...");
    const snapshot = await domProcessor.getSnapshot();
    console.log("Snapshot root tag:", snapshot.tagName);
    console.log("Snapshot child count:", snapshot.children?.length);

    console.log("Simulating interaction...");
    // Find the link
    const link = snapshot.children
      ?.find((c) => c.tagName === "div")
      ?.children?.find((c) => c.tagName === "p")
      ?.children?.find((c) => c.tagName === "a");

    if (link) {
      console.log("Found link, moving mouse...");
      // We need to use a selector or coordinates. Since we have IDs in the snapshot, let's try to get element handle by ID
      const elementHandle = await domProcessor.getElementById(link.id);
      if (elementHandle) {
        const box = await elementHandle.boundingBox();
        if (box) {
          await humanizer.move("a"); // Moving to selector for now as ghost-cursor uses selectors or elements
          console.log("Moved to link");
        }
      }
    }

    console.log("Test complete!");
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await manager.close();
  }
}

runTest();

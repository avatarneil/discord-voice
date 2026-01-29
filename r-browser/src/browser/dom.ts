import { Page, ElementHandle } from "playwright";

export interface DOMElement {
  id: string;
  tagName: string;
  text?: string;
  attributes: Record<string, string>;
  isVisible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  children?: DOMElement[];
}

export class DOMProcessor {
  private page: Page;
  private elementCache: Map<string, ElementHandle> = new Map();
  private idCounter = 0;

  constructor(page: Page) {
    this.page = page;
  }

  async getSnapshot(selector?: string): Promise<DOMElement> {
    this.elementCache.clear();
    this.idCounter = 0;

    // Inject a script to traverse the DOM and extract relevant info
    // We use evaluate to run this inside the browser context
    const snapshot = await this.page.evaluate(
      (args) => {
        const { rootSelector } = args;
        const root = rootSelector ? document.querySelector(rootSelector) : document.body;

        if (!root) {
          throw new Error(`Element not found: ${rootSelector}`);
        }

        let counter = 0;

        // Helper types for inside evaluate
        interface SerializedElement {
          id: string;
          tagName: string;
          text?: string;
          attributes: Record<string, string>;
          isVisible: boolean;
          rect?: { x: number; y: number; width: number; height: number };
          children?: SerializedElement[];
        }

        function isVisible(elem: Element): boolean {
          const style = window.getComputedStyle(elem);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            elem.getBoundingClientRect().width > 0 &&
            elem.getBoundingClientRect().height > 0
          );
        }

        function getAttributes(elem: Element): Record<string, string> {
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(elem.attributes)) {
            if (
              ["id", "name", "class", "role", "aria-label", "placeholder", "href", "value", "type"].includes(attr.name)
            ) {
              attrs[attr.name] = attr.value;
            }
          }
          return attrs;
        }

        function traverse(node: Element): SerializedElement | null {
          if (!isVisible(node)) return null;

          // Assign a temporary unique ID for mapping back
          const id = `el_${++counter}`;
          node.setAttribute("data-r-browser-id", id);

          const elementData: SerializedElement = {
            id,
            tagName: node.tagName.toLowerCase(),
            attributes: getAttributes(node),
            isVisible: true,
            rect: node.getBoundingClientRect().toJSON(),
            children: [],
          };

          // Text content for leaf nodes or significant text
          if (node.childNodes.length > 0) {
            let hasText = false;
            for (const child of Array.from(node.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
                if (!elementData.text) elementData.text = "";
                elementData.text += child.textContent.trim() + " ";
                hasText = true;
              } else if (child.nodeType === Node.ELEMENT_NODE) {
                const childData = traverse(child as Element);
                if (childData && elementData.children) {
                  elementData.children.push(childData);
                }
              }
            }
            if (elementData.text) elementData.text = elementData.text.trim();
          }

          return elementData;
        }

        return traverse(root);
      },
      { rootSelector: selector },
    );

    // Cast the result to DOMElement (it matches the shape)
    return snapshot as unknown as DOMElement;
  }

  async getElementById(id: string): Promise<ElementHandle | null> {
    // Find element by the injected data attribute
    try {
      return await this.page.$(`[data-r-browser-id="${id}"]`);
    } catch (e) {
      return null;
    }
  }
}

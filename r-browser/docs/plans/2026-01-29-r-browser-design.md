# r-browser Design Document

## Overview

`r-browser` (Real Browser) is a Model Context Protocol (MCP) server that provides AI agents with authentic, human-like web browsing capabilities. Unlike standard headless browsers, `r-browser` focuses on undetectability ("stealth"), persistent sessions, and high-fidelity interaction simulation to bypass anti-bot measures (WAFs, Cloudflare, CAPTCHAs) without relying on external solving services like FlareSolverr.

## Goals

1.  **Undetectability**: Pass standard bot checks (e.g., specific tests like `navigator.webdriver`, consistent user-agent/platform matching).
2.  **Human-Like Interaction**: Simulate mouse movements, variable typing speeds, and reaction delays.
3.  **Persistence**: Maintain login sessions across restarts using persistent browser profiles.
4.  **Flexibility**: Support standard Chrome by default but easily configurable for specific Chromium forks like Helium.
5.  **LLM-First Interface**: Expose the DOM in a semantic, token-efficient JSON format rather than raw HTML.

## Architecture

The system is built as a standalone Node.js MCP server.

### 1. Browser Manager

- **Library**: `playwright-extra` coupled with `puppeteer-extra-plugin-stealth`.
- **Configuration**:
    - `BROWSER_EXECUTABLE_PATH`: Path to the browser binary (default: auto-detected Chrome).
    - `USER_DATA_DIR`: Path to the profile directory for session persistence.
    - `HEADLESS`: Configurable (default: `false` for maximum stealth, or `new` headless mode).
- **Responsibilities**: Managing the browser process lifecycle, context creation, and plugin injection.

### 2. Input Simulator (Humanizer)

- **Mouse**: Uses Bezier curve algorithms to generate non-linear mouse paths. Adds "jitter" (micro-movements) and overshooting corrections.
- **Keyboard**: Implements variable keystroke delays (Gaussian distribution) and occasional "mistakes" (wrong key + backspace) for realistic typing.
- **Timing**: Randomizes delays between actions (thinking time).

### 3. DOM Processor

- **Objective**: Convert complex HTML into a simplified JSON tree for the LLM.
- **Extraction Logic**:
    - Filter invisible or irrelevant elements (scripts, styles, hidden inputs).
    - Generate unique short IDs for every interactable element.
    - Extract semantic attributes: `role`, `aria-label`, `placeholder`, `text`, `value`.
    - Compute visibility and coordinates.

### 4. MCP Tools Interface

The server exposes the following tools to the AI agent:

- `browser_navigate(url: string)`: Go to a URL with human-like loading behavior.
- `browser_screenshot(full_page: boolean)`: Return a base64 encoded screenshot.
- `browser_get_dom(selector?: string)`: Return the simplified JSON DOM snapshot.
- `browser_click(element_id: string | null, selector: string | null, coordinates: [x, y] | null)`: Move mouse human-like to target and click.
- `browser_type(element_id: string | null, selector: string | null, text: string, submit: boolean)`: Focus and type text with variable speed.
- `browser_scroll(delta_x: number, delta_y: number)`: Scroll the viewport.
- `browser_evaluate(script: string)`: Execute custom JavaScript in the page context.

## Implementation Plan

### Dependencies

- `@modelcontextprotocol/sdk`
- `playwright`
- `playwright-extra`
- `puppeteer-extra-plugin-stealth`
- `ghost-cursor` (for advanced mouse movement simulation)

### Configuration

The server will support configuration via arguments or `.env` file:

```bash
# Example
R_BROWSER_BIN="/usr/bin/helium"
R_BROWSER_PROFILE="/root/.config/net.imput.helium"
```

## Security & Ethics

This tool is a powerful automation utility. It is designed for personal assistance and testing. It does not include built-in capabilities for credential harvesting or malicious payloads.

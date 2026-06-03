/**
 * Browser actions — JSON-based browser automation via Playwright.
 *
 * Replaces the AgentScript DSL with a simple JSON action format
 * that any AI agent can generate without learning a custom language.
 *
 * Each action is an object with a single key (the verb) and a value
 * (the argument or argument array):
 *
 * ```json
 * { "click": "button Sign in" }
 * { "fill": ["textbox Email", "alice@example.com"] }
 * { "goto": "http://localhost:3000" }
 * { "wait": "500ms" }
 * { "press": "Enter" }
 * { "type": ["textbox Search", "hello", { "delay": 100 }] }
 * ```
 *
 * Selectors use the same resolution as before:
 * - ARIA role + name: `"button Sign in"`, `"textbox Email"`
 * - Prefixed: `"label:Email"`, `"placeholder:Search"`, `"testid:submit"`
 * - CSS: `"#id"`, `".class"`, `"div > a"`
 *
 * @module
 */

import type { Page, Locator } from 'playwright'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Types ────────────────────────────────────────────────────────────

/**
 * A single browser action. Object with one key (verb) and value (args).
 *
 * @example
 * ```ts
 * const actions: BrowserAction[] = [
 *   { click: "button Sign in" },
 *   { fill: ["textbox Email", "alice"] },
 *   { goto: "http://localhost:3000" },
 *   { wait: "500ms" },
 * ]
 * ```
 */
export type BrowserAction = Record<string, unknown>

/** Result of executing a batch of actions */
export interface ActionResult {
  /** Number of actions completed successfully */
  completed: number
  /** Total number of actions */
  total: number
  /** Error message if an action failed */
  error?: string
  /** Index of the failed action (0-based) */
  failedAt?: number
  /** Whether the agent should re-snapshot after this */
  needsSnapshot: boolean
}

// ── Executor ─────────────────────────────────────────────────────────

/**
 * Execute a list of browser actions sequentially.
 *
 * Stops at the first failure and reports which action failed.
 *
 * @param actions - Array of action objects
 * @param page - Playwright page instance
 * @param timeoutMs - Per-action timeout (default: 4000ms)
 * @returns Result with completion count and optional error
 */
export async function runActions(
  actions: BrowserAction[],
  page: Page,
  timeoutMs = 4000,
): Promise<ActionResult> {
  let completed = 0
  let needsSnapshot = false

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    const [verb, rawArgs] = parseAction(action)

    try {
      const navigated = await executeAction(verb, rawArgs, page, timeoutMs)
      if (navigated) needsSnapshot = true
      completed++
    } catch (e: any) {
      return {
        completed,
        total: actions.length,
        error: `Action ${i}: ${verb} failed — ${e.message}`,
        failedAt: i,
        needsSnapshot: true,
      }
    }
  }

  return { completed, total: actions.length, needsSnapshot }
}

// ── Action parsing ───────────────────────────────────────────────────

/**
 * Extract verb and args from an action object.
 * @internal
 */
function parseAction(action: BrowserAction): [string, unknown] {
  const keys = Object.keys(action)
  if (keys.length !== 1) {
    throw new Error(
      `Each action must have exactly one key (the verb). ` +
      `Got: ${JSON.stringify(keys)}`,
    )
  }
  return [keys[0].toLowerCase(), action[keys[0]]]
}

// ── Action execution ─────────────────────────────────────────────────

/**
 * Execute a single action. Returns `true` if it caused navigation.
 * @internal
 */
async function executeAction(
  verb: string,
  args: unknown,
  page: Page,
  timeout: number,
): Promise<boolean> {
  const opt = { timeout }

  switch (verb) {
    // ── Navigation ─────────────────────────────────────────────────
    case 'goto': {
      let url = String(args)
      if (!url.startsWith('http')) url = `https://${url}`
      await page.goto(url, { timeout, waitUntil: 'domcontentloaded' })
      return true
    }
    case 'back':    await page.goBack(opt); return true
    case 'forward': await page.goForward(opt); return true
    case 'reload':  await page.reload(opt); return true

    // ── Click ──────────────────────────────────────────────────────
    case 'click': {
      const loc = resolveSelector(page, String(args))
      await loc.click(opt)
      return false
    }
    case 'dblclick': {
      const loc = resolveSelector(page, String(args))
      await loc.dblclick(opt)
      return false
    }
    case 'rclick': {
      const loc = resolveSelector(page, String(args))
      await loc.click({ ...opt, button: 'right' })
      return false
    }

    // ── Fill / Type ────────────────────────────────────────────────
    case 'fill': {
      const [selector, value] = asArray(args)
      const loc = resolveSelector(page, String(selector))
      await loc.fill(String(value), opt)
      return false
    }
    case 'clear': {
      const loc = resolveSelector(page, String(args))
      await loc.clear(opt)
      return false
    }
    case 'type': {
      const arr = asArray(args)
      const loc = resolveSelector(page, String(arr[0]))
      const text = String(arr[1])
      const delay = typeof arr[2] === 'object' && arr[2] !== null
        ? (arr[2] as any).delay ?? 50
        : 50
      await loc.pressSequentially(text, { delay, timeout })
      return false
    }

    // ── Keyboard ───────────────────────────────────────────────────
    case 'press': {
      const str = String(args)
      // If it has a selector: ["textbox Email", "Enter"]
      if (Array.isArray(args) && args.length >= 2) {
        const loc = resolveSelector(page, String(args[0]))
        await loc.press(String(args[1]), opt)
      } else {
        await page.keyboard.press(str)
      }
      return false
    }

    // ── Select / Check ─────────────────────────────────────────────
    case 'select': {
      const [selector, ...values] = asArray(args)
      const loc = resolveSelector(page, String(selector))
      await loc.selectOption(values.map(String), opt)
      return false
    }
    case 'check': {
      const loc = resolveSelector(page, String(args))
      await loc.check(opt)
      return false
    }
    case 'uncheck': {
      const loc = resolveSelector(page, String(args))
      await loc.uncheck(opt)
      return false
    }

    // ── Hover / Focus / Scroll ─────────────────────────────────────
    case 'hover': {
      const loc = resolveSelector(page, String(args))
      await loc.hover(opt)
      return false
    }
    case 'focus': {
      const loc = resolveSelector(page, String(args))
      await loc.focus(opt)
      return false
    }
    case 'scroll': {
      if (Array.isArray(args) && args.length >= 2) {
        const [selector, direction] = args
        const loc = resolveSelector(page, String(selector))
        const dir = String(direction).toLowerCase()
        const delta = dir === 'up' ? -300 : dir === 'down' ? 300 : 0
        await loc.evaluate((el: any, d: number) => el.scrollBy(0, d), delta)
      } else {
        const dir = String(args).toLowerCase()
        const delta = dir === 'up' ? -300 : 300
        await page.evaluate((d: number) => window.scrollBy(0, d), delta)
      }
      return false
    }

    // ── Wait ───────────────────────────────────────────────────────
    case 'wait': {
      const str = String(args)
      // "500ms" or "2s" → sleep
      const msMatch = str.match(/^(\d+)\s*ms$/i)
      if (msMatch) {
        await page.waitForTimeout(parseInt(msMatch[1]))
        return false
      }
      const sMatch = str.match(/^(\d+)\s*s$/i)
      if (sMatch) {
        await page.waitForTimeout(parseInt(sMatch[1]) * 1000)
        return false
      }
      // Array: ["selector", "visible"|"hidden"]
      if (Array.isArray(args) && args.length >= 2) {
        const loc = resolveSelector(page, String(args[0]))
        const state = String(args[1]).toLowerCase()
        await loc.waitFor({
          state: state === 'hidden' ? 'hidden' : 'visible',
          timeout,
        })
        return false
      }
      // Default: wait for selector to be visible
      const loc = resolveSelector(page, str)
      await loc.waitFor({ state: 'visible', timeout })
      return false
    }
    case 'waiturl': {
      const pattern = String(args)
      await page.waitForURL(pattern.includes('*') ? pattern : `**${pattern}**`, { timeout })
      return false
    }

    // ── Upload ─────────────────────────────────────────────────────
    case 'upload': {
      const [selector, ...files] = asArray(args)
      const loc = resolveSelector(page, String(selector))
      await loc.setInputFiles(files.map(String), opt)
      return false
    }

    // ── Dialog ─────────────────────────────────────────────────────
    case 'ondialog': {
      const action = String(args).toLowerCase()
      page.once('dialog', async (dialog) => {
        if (action === 'dismiss') await dialog.dismiss()
        else await dialog.accept(action === 'accept' ? undefined : action)
      })
      return false
    }

    default:
      throw new Error(`Unknown action: "${verb}". Available: click, fill, goto, type, press, select, check, uncheck, hover, wait, waiturl, scroll, upload, ondialog, back, forward, reload`)
  }
}

// ── Selector resolution ──────────────────────────────────────────────

/**
 * ARIA role set for snapshot-style selectors ("button Sign In").
 * Kept as module-level constant for performance.
 */
const ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'article', 'banner', 'blockquote', 'button',
  'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'form',
  'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion',
  'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
  'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option',
  'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong',
  'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist',
  'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
])

/**
 * Resolve a selector string into a Playwright locator.
 *
 * Supports (in priority order):
 * 1. Prefixed: `"role:button=Sign in"`, `"label:Email"`, `"testid:submit"`
 * 2. ARIA role + name: `"button Sign in"`, `"textbox Email"` (from snapshot)
 * 3. CSS: `"#id"`, `".class"`, `"div > a"`
 */
export function resolveSelector(page: Page, spec: string): Locator {
  const trimmed = spec.trim()

  // Remove surrounding quotes if present
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed

  // Prefixed selectors: role:button=Save, label:Email, etc.
  const colon = unquoted.indexOf(':')
  if (colon > 0) {
    const prefix = unquoted.slice(0, colon)
    const rest = unquoted.slice(colon + 1)
    switch (prefix) {
      case 'role': {
        const eq = rest.indexOf('=')
        if (eq >= 0) {
          return page.getByRole(rest.slice(0, eq).trim() as any, {
            name: rest.slice(eq + 1).trim(),
          })
        }
        return page.getByRole(rest.trim() as any)
      }
      case 'text':        return page.getByText(rest)
      case 'label':       return page.getByLabel(rest)
      case 'placeholder': return page.getByPlaceholder(rest)
      case 'testid':      return page.getByTestId(rest)
      case 'alt':         return page.getByAltText(rest)
      case 'title':       return page.getByTitle(rest)
    }
  }

  // Snapshot refs: "button Sign In" → getByRole('button', { name: 'Sign In' })
  const spaceIdx = unquoted.indexOf(' ')
  if (spaceIdx > 0) {
    const maybeRole = unquoted.slice(0, spaceIdx).toLowerCase()
    if (ARIA_ROLES.has(maybeRole)) {
      let name = unquoted.slice(spaceIdx + 1).trim()
      // Strip inner quotes
      if ((name.startsWith('"') && name.endsWith('"'))
        || (name.startsWith("'") && name.endsWith("'"))) {
        name = name.slice(1, -1)
      }
      return page.getByRole(maybeRole as any, { name })
    }
  }

  // Bare ARIA role: "button" → getByRole('button')
  if (ARIA_ROLES.has(unquoted.toLowerCase())) {
    return page.getByRole(unquoted.toLowerCase() as any)
  }

  // Fallback: CSS selector
  return page.locator(unquoted)
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Normalize args to an array (wrap scalar in array) */
function asArray(args: unknown): unknown[] {
  if (Array.isArray(args)) return args
  return [args]
}

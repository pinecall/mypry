/**
 * AgentScript runtime
 * -------------------
 * Executes parsed Steps against a Playwright Page.
 */

import type { Page, Locator } from 'playwright';
import { type Step, type Arg, asString, asNumber, asWord } from './parser.js';

/** Ref map from snapshot: ref → CSS/XPath selector. */
export type RefMap = Record<string, string>;

export interface RunOptions {
  page: Page;
  refMap: RefMap;
  vars?: Record<string, string>;
  /** Default timeout per step in ms. */
  timeoutMs?: number;
  /** Hook for logging per step. */
  onStep?: (step: Step, status: 'start' | 'ok' | 'fail', detail?: string) => void;
}

export interface StepResult {
  step: Step;
  ok: boolean;
  error?: string;
  output?: unknown;
}

export interface RunResult {
  completed: StepResult[];
  failed?: StepResult;
  vars: Record<string, string>;
}

function locator(page: Page, refMap: RefMap, ref: string): Locator {
  const sel = refMap[ref];
  if (!sel) throw new Error(`unknown ref: ${ref} (not in refMap / snapshot)`);
  return page.locator(sel);
}

/**
 * Resolve an Arg as a Locator:
 *   - bareword `e\d+`  → lookup in refMap (from snapshot)
 *   - string literal   → selector spec (see parseSelector)
 */
function resolveLocator(page: Page, refMap: RefMap, arg: Arg | undefined): Locator {
  if (!arg) throw new Error('expected element target (e.g. e15 or "#submit")');

  if (arg.kind === 'word') {
    if (!/^e\d+$/.test(arg.value)) {
      throw new Error(`expected ref like e15 or quoted "selector", got bareword: ${arg.value}`);
    }
    return locator(page, refMap, arg.value);
  }

  if (arg.kind === 'string') {
    return parseSelector(page, arg.value);
  }

  throw new Error(`expected element target, got ${arg.kind}`);
}

/** Fast-fail: check if a locator matches any element within a short window. */
async function assertExists(loc: Locator, spec: string, timeoutMs = 500): Promise<void> {
  try {
    await loc.waitFor({ state: 'attached', timeout: timeoutMs })
  } catch {
    const count = await loc.count()
    if (count === 0) {
      throw new Error(
        `No element found for "${spec}". ` +
        `Take a snapshot to see what's on the page.`
      )
    }
  }
}

/**
 * Parse a string as a Playwright locator. Supports user-facing prefixes
 * and snapshot refs (ARIA role + name).
 *
 *   role:button=Sign in      getByRole('button', { name: 'Sign in' })
 *   text:Sign in             getByText('Sign in')
 *   label:Email              getByLabel('Email')
 *   placeholder:Search       getByPlaceholder('Search')
 *   testid:submit            getByTestId('submit')
 *   alt:Logo                 getByAltText('Logo')
 *   title:Close              getByTitle('Close')
 *   #id .class div > a       page.locator(CSS)
 *
 * Snapshot refs (from debugger_snapshot):
 *   button "Sign In"         getByRole('button', { name: 'Sign In' })
 *   textbox "Email"          getByRole('textbox', { name: 'Email' })
 *   link "Dashboard"         getByRole('link', { name: 'Dashboard' })
 */
function parseSelector(page: Page, spec: string): Locator {
  const trimmed = spec.trim();

  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    const rest = trimmed.slice(colon + 1);
    switch (prefix) {
      case 'role': {
        const eq = rest.indexOf('=');
        if (eq >= 0) {
          const role = rest.slice(0, eq).trim();
          const name = rest.slice(eq + 1).trim();
          return page.getByRole(role as any, { name });
        }
        return page.getByRole(rest.trim() as any);
      }
      case 'text':        return page.getByText(rest);
      case 'label':       return page.getByLabel(rest);
      case 'placeholder': return page.getByPlaceholder(rest);
      case 'testid':      return page.getByTestId(rest);
      case 'alt':         return page.getByAltText(rest);
      case 'title':       return page.getByTitle(rest);
    }
  }

  // Snapshot refs: "button Sign In" → getByRole('button', { name: 'Sign In' })
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
  ]);

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx > 0) {
    const maybeRole = trimmed.slice(0, spaceIdx).toLowerCase();
    if (ARIA_ROLES.has(maybeRole)) {
      let name = trimmed.slice(spaceIdx + 1).trim();
      if ((name.startsWith('"') && name.endsWith('"')) ||
          (name.startsWith("'") && name.endsWith("'"))) {
        name = name.slice(1, -1);
      }
      return page.getByRole(maybeRole as any, { name });
    }
  }
  if (ARIA_ROLES.has(trimmed.toLowerCase())) {
    return page.getByRole(trimmed.toLowerCase() as any);
  }

  return page.locator(trimmed);
}

/** True if arg is a plausible target (ref-like word OR string). */
function isTargetArg(a: Arg | undefined): boolean {
  if (!a) return false;
  if (a.kind === 'string') return true;
  if (a.kind === 'word' && /^e\d+$/.test(a.value)) return true;
  return false;
}

interface RunContext {
  page: Page;
  refMap: RefMap;
  vars: Record<string, string>;
  timeout: number;
  /** Dialog policy: 'accept' | 'dismiss' | undefined (Playwright default). */
  dialogPolicy?: { action: 'accept' | 'dismiss'; promptText?: string };
}

export async function run(script: Step[], opts: RunOptions): Promise<RunResult> {
  const { page, refMap, onStep } = opts;
  const vars: Record<string, string> = { ...(opts.vars ?? {}) };
  const timeout = opts.timeoutMs ?? 4_000;
  const completed: StepResult[] = [];

  const ctx: RunContext = { page, refMap, vars, timeout };

  // Dialog handler
  page.on('dialog', async (dialog) => {
    const pol = ctx.dialogPolicy;
    try {
      if (!pol) return;
      if (pol.action === 'accept') await dialog.accept(pol.promptText);
      else await dialog.dismiss();
    } catch { /* dialog already resolved */ }
  });

  for (const step of script) {
    onStep?.(step, 'start');
    try {
      const output = await execute(step, ctx);
      completed.push({ step, ok: true, output });
      onStep?.(step, 'ok');
      if (step.verb === 'snapshot') {
        return { completed, vars };
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const failed: StepResult = { step, ok: false, error: msg };
      onStep?.(step, 'fail', msg);
      return { completed, failed, vars };
    }
  }

  return { completed, vars };
}

async function execute(step: Step, ctx: RunContext): Promise<unknown> {
  const { verb, args } = step;
  const { refMap, vars, timeout } = ctx;
  const page = ctx.page;
  const opt = { timeout };

  /** Resolve + fast-fail. */
  const resolve = async (arg: Arg | undefined): Promise<Locator> => {
    const loc = resolveLocator(page, refMap, arg);
    const spec = arg?.kind === 'string' ? arg.value : arg?.kind === 'word' ? arg.value : '?';
    await assertExists(loc, spec);
    return loc;
  };

  switch (verb) {
    // ─── navigation ────────────────────────────────────────────────
    case 'goto': {
      const url = asString(args[0], vars);
      if (!url) throw new Error('goto requires a URL');
      const waitUntil = (asWord(args[1]) ?? 'domcontentloaded') as
        'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      await page.goto(url, { timeout, waitUntil });
      return;
    }
    case 'back':    await page.goBack({ timeout });    return;
    case 'forward': await page.goForward({ timeout }); return;
    case 'reload':  await page.reload({ timeout });    return;

    // ─── interaction ───────────────────────────────────────────────
    case 'click':    return (await resolve(args[0])).click(opt);
    case 'dblclick': return (await resolve(args[0])).dblclick(opt);
    case 'rclick':   return (await resolve(args[0])).click({ ...opt, button: 'right' });

    case 'fill': {
      const text = asString(args[1], vars);
      if (text === undefined) throw new Error('fill requires text');
      return (await resolve(args[0])).fill(text, opt);
    }
    case 'clear': return (await resolve(args[0])).clear(opt);

    case 'type': {
      const first = args[0];
      let target: Locator | null = null;
      let textArg: Arg | undefined;
      if (isTargetArg(first) && args.length >= 2) {
        target = await resolve(first);
        textArg = args[1];
      } else {
        textArg = args[0];
      }
      const text = asString(textArg, vars);
      if (text === undefined) throw new Error('type requires text');
      if (target) await target.pressSequentially(text, opt);
      else await page.keyboard.type(text);
      return;
    }
    case 'press': {
      const first = args[0];
      if (isTargetArg(first) && args.length >= 2) {
        const key = asWord(args[1]) ?? asString(args[1], vars);
        if (!key) throw new Error('press requires a key');
        return (await resolve(first)).press(key, opt);
      }
      const key = asWord(first) ?? asString(first, vars);
      if (!key) throw new Error('press requires a key');
      return page.keyboard.press(key);
    }
    case 'select': {
      const value = asString(args[1], vars);
      if (value === undefined) throw new Error('select requires a value');
      return (await resolve(args[0])).selectOption(value, opt);
    }
    case 'check':   return (await resolve(args[0])).check(opt);
    case 'uncheck': return (await resolve(args[0])).uncheck(opt);
    case 'hover':   return (await resolve(args[0])).hover(opt);
    case 'focus':   return (await resolve(args[0])).focus(opt);
    case 'upload': {
      const path = asString(args[1], vars);
      if (!path) throw new Error('upload requires a file path');
      return (await resolve(args[0])).setInputFiles(path, opt);
    }

    // ─── scroll ────────────────────────────────────────────────────
    case 'scroll': {
      const first = args[0];
      if (asWord(first) === 'page') {
        const dir = asWord(args[1]) ?? 'down';
        const amount = asNumber(args[2]) ?? 600;
        if (dir === 'to') {
          await page.evaluate((y: number) => window.scrollTo(0, y), amount);
        } else {
          const dy = dir === 'up' ? -amount : amount;
          await page.mouse.wheel(0, dy);
        }
        return;
      }
      if (isTargetArg(first)) {
        return resolveLocator(page, refMap, first).scrollIntoViewIfNeeded(opt);
      }
      throw new Error('scroll expects a ref/selector or `page <up|down|to> [N]`');
    }

    // ─── wait ──────────────────────────────────────────────────────
    case 'wait': {
      const first = args[0];
      if (first?.kind === 'number') {
        const ms = first.unit === 'ms' ? first.value : first.value * 1000;
        await page.waitForTimeout(ms);
        return;
      }
      const loc = resolveLocator(page, refMap, first);
      const state = (asWord(args[1]) ?? 'visible') as
        'visible' | 'hidden' | 'attached' | 'detached';
      await loc.waitFor({ state, timeout });
      return;
    }

    case 'snapshot': return { snapshot: true };

    // ─── load / URL wait ───────────────────────────────────────────
    case 'waitload': {
      const state = (asWord(args[0]) ?? 'load') as 'load' | 'domcontentloaded' | 'networkidle';
      await page.waitForLoadState(state, { timeout });
      return;
    }
    case 'waiturl': {
      const pat = asString(args[0], vars);
      if (!pat) throw new Error('waiturl requires a pattern');
      const matcher = pat.startsWith('^') || pat.includes('.*')
        ? new RegExp(pat)
        : (url: string) => url.includes(pat);
      await page.waitForURL(matcher as any, { timeout });
      return;
    }

    // ─── dialogs ───────────────────────────────────────────────────
    case 'ondialog': {
      const action = asWord(args[0]);
      if (action === 'accept') {
        ctx.dialogPolicy = { action: 'accept', promptText: asString(args[1], vars) };
      } else if (action === 'dismiss') {
        ctx.dialogPolicy = { action: 'dismiss' };
      } else if (action === 'default') {
        ctx.dialogPolicy = undefined;
      } else {
        throw new Error('ondialog expects: accept ["text"] | dismiss | default');
      }
      return { dialogPolicy: ctx.dialogPolicy ?? 'default' };
    }

    default:
      throw new Error(`unknown verb: ${verb}`);
  }
}

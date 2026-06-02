/**
 * Helpers de conexión al navegador.
 *
 * Para integraciones con extensiones de browser, casi siempre se usa CDP:
 * el usuario ya tiene su Chromium abierto con --remote-debugging-port=9222,
 * y AgentScript se conecta a esa misma sesión. Cerrar `browser` en ese caso
 * solo desconecta — no mata el proceso real del navegador.
 */

import { chromium, type Browser, type Page } from 'playwright';

export interface ConnectOptions {
  /** URL del endpoint CDP, p.ej. http://localhost:9222 */
  cdpEndpoint?: string;
  /** Si no hay CDP, lanzamos uno. */
  headless?: boolean;
  /** Cuando se conecta vía CDP, elige una página cuyo URL matchee este regex. */
  pageUrlMatch?: string;
  /** Si no hay página existente al conectar, ¿abrir una nueva? (default: true) */
  openNewIfEmpty?: boolean;
}

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  /** true si nosotros lanzamos el browser (debemos cerrarlo);
   *  false si nos conectamos vía CDP (solo desconectamos). */
  owned: boolean;
}

export async function connect(opts: ConnectOptions = {}): Promise<BrowserHandle> {
  if (opts.cdpEndpoint) {
    const browser = await chromium.connectOverCDP(opts.cdpEndpoint);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error(`CDP browser at ${opts.cdpEndpoint} has no contexts`);
    }
    const ctx = contexts[0];
    let pages = ctx.pages();

    if (opts.pageUrlMatch) {
      const re = new RegExp(opts.pageUrlMatch);
      pages = pages.filter(p => re.test(p.url()));
    }

    let page: Page;
    if (pages.length > 0) {
      page = pages[0];
    } else if (opts.openNewIfEmpty !== false) {
      page = await ctx.newPage();
    } else {
      throw new Error(`no matching page in CDP browser (filter: ${opts.pageUrlMatch ?? '(none)'})`);
    }

    return { browser, page, owned: false };
  }

  const browser = await chromium.launch({ headless: opts.headless ?? false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { browser, page, owned: true };
}

/** Cierra/desconecta el browser de forma segura. */
export async function dispose(handle: BrowserHandle): Promise<void> {
  // browser.close() en una conexión CDP solo desconecta — no mata el navegador.
  // En un browser lanzado por nosotros, cierra el proceso. En ambos casos OK.
  await handle.browser.close();
}

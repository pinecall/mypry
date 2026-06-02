/**
 * Session — estado de navegación persistente y reutilizable.
 *
 * Una Session envuelve un browser + página activa + refMap + vars, y vive
 * mientras vivás el proceso que la creó. Sirve para:
 *   - El MCP server: una Session en memoria, varios tool-calls la comparten.
 *   - El CLI con --session: serializa vars/refMap a disco entre invocaciones
 *     (el browser persiste vía CDP).
 *
 * Snapshot:
 *   Si NO tenés extensión, la Session puede generar su propio refMap a partir
 *   del ARIA snapshot de Playwright (page.ariaSnapshot({ ref: true })). Cada
 *   elemento interactivo recibe un ref `eN`, resoluble vía el selector
 *   `aria-ref=eN`. Si tenés tu extensión, le pasás tu propio refMap y listo.
 */

import { connect, dispose, type BrowserHandle, type ConnectOptions } from './connect.js';
import { type RefMap } from './runtime.js';

export interface SessionState {
  vars: Record<string, string>;
  refMap: RefMap;
  /** Último snapshot YAML (para referencia/debug). */
  lastSnapshot?: string;
}

export class Session {
  handle: BrowserHandle;
  state: SessionState;

  private constructor(handle: BrowserHandle, state?: Partial<SessionState>) {
    this.handle = handle;
    this.state = {
      vars: state?.vars ?? {},
      refMap: state?.refMap ?? {},
      lastSnapshot: state?.lastSnapshot,
    };
  }

  static async open(opts: ConnectOptions, state?: Partial<SessionState>): Promise<Session> {
    const handle = await connect(opts);
    return new Session(handle, state);
  }

  get page() { return this.handle.page; }

  /**
   * Genera un ARIA snapshot de la página con refs estables y reconstruye
   * el refMap (eN → "aria-ref=eN"). Devuelve el YAML para mandar al modelo.
   *
   * scope opcional: un CSS selector para acotar el snapshot.
   */
  async snapshot(scope?: string): Promise<{ yaml: string; refMap: RefMap }> {
    const root = scope ? this.page.locator(scope) : this.page.locator('body');
    // ref:true agrega [ref=eN]; ariaSnapshot está disponible desde Playwright 1.52+
    const yaml = await (root as any).ariaSnapshot({ ref: true });

    // Extraemos los refs del YAML y los mapeamos al selector aria-ref.
    const refMap: RefMap = {};
    for (const m of yaml.matchAll(/\[ref=(e\d+)\]/g)) {
      const ref = m[1];
      refMap[ref] = `aria-ref=${ref}`;
    }

    // Mergeamos sobre el refMap existente (la extensión puede haber puesto otros).
    this.state.refMap = { ...this.state.refMap, ...refMap };
    this.state.lastSnapshot = yaml;
    return { yaml, refMap: this.state.refMap };
  }

  /** Reemplaza/mergea el refMap (p.ej. el que emite tu extensión). */
  setRefMap(refMap: RefMap, mode: 'replace' | 'merge' = 'replace') {
    this.state.refMap = mode === 'merge' ? { ...this.state.refMap, ...refMap } : { ...refMap };
  }

  setVars(vars: Record<string, string>, mode: 'replace' | 'merge' = 'merge') {
    this.state.vars = mode === 'merge' ? { ...this.state.vars, ...vars } : { ...vars };
  }

  async close() {
    await dispose(this.handle);
  }

  /** Serializa el estado liviano (vars + refMap) para persistir a disco. */
  serialize(): SessionState {
    return { vars: this.state.vars, refMap: this.state.refMap, lastSnapshot: this.state.lastSnapshot };
  }
}

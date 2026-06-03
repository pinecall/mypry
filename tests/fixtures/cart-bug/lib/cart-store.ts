// Store de carritos en memoria, indexado por sessionId.
// Patrón singleton típico: el módulo se carga una vez y el objeto
// persiste entre peticiones mientras el servidor esté vivo.

export type CartState = {
  items: { sku: string; name: string; price: number; qty: number }[];
  // Descuento aplicado por cupón, en porcentaje (0–100).
  discountPct: number;
  couponCode: string | null;
};

// Catálogo fijo para la demo.
export const CATALOG: Record<string, { name: string; price: number }> = {
  KEY: { name: "Mechanical Keyboard", price: 120 },
  MSE: { name: "Wireless Mouse", price: 45 },
  PAD: { name: "Desk Mat", price: 25 },
};

export const COUPONS: Record<string, number> = {
  SAVE10: 10,
  SAVE25: 25,
};

// El store. Vive en memoria, compartido entre todas las peticiones.
// Usamos globalThis para que el Map sobreviva los reloads de HMR
// en modo desarrollo de Next.js (sin esto, cada recompilación crea
// un Map nuevo y el estado se pierde entre requests).
const globalKey = "__mypry_demo_carts__";
const carts: Map<string, CartState> =
  (globalThis as any)[globalKey] ??= new Map<string, CartState>();

function freshCart(): CartState {
  return { items: [], discountPct: 0, couponCode: null };
}

export function getCart(sessionId: string): CartState {
  let cart = carts.get(sessionId);
  if (!cart) {
    cart = freshCart();
    carts.set(sessionId, cart);
  }
  return cart;
}

// Vaciar el carrito: quitamos los productos.
// Mutamos en sitio para conservar la misma referencia del objeto
// (otras partes del sistema podrían tener un puntero a él).
export function clearCart(sessionId: string): void {
  const cart = getCart(sessionId);
  cart.items = [];
  // Se vacían los items. El cupón se gestiona en su propio endpoint,
  // así que aquí no lo tocamos.
}

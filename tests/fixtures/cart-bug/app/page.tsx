"use client";

import { useState } from "react";

type TotalResp = {
  items: { sku: string; name: string; price: number; qty: number }[];
  subtotal: number;
  discountPct: number;
  couponCode: string | null;
  discount: number;
  total: number;
};

// Un sessionId estable por carga de página. Todas las acciones de esta
// sesión pegan al mismo carrito en el servidor.
const SESSION_ID = "sess_" + Math.random().toString(36).slice(2, 10);

async function post(path: string, body: object) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
  });
  return res.json();
}

export default function CartPage() {
  const [snapshot, setSnapshot] = useState<TotalResp | null>(null);
  const [log, setLog] = useState<string[]>([]);

  function note(line: string) {
    setLog((l) => [line, ...l].slice(0, 8));
  }

  async function refreshTotal() {
    const data: TotalResp = await post("/api/cart/total", {});
    setSnapshot(data);
    return data;
  }

  async function addItem(sku: string) {
    await post("/api/cart/add", { sku });
    note(`+ anadido ${sku}`);
    await refreshTotal();
  }

  async function applyCoupon(code: string) {
    const r = await post("/api/cart/coupon", { code });
    note(`% cupon ${code} (${r.discountPct ?? "?"}%)`);
    await refreshTotal();
  }

  async function clearCart() {
    await post("/api/cart/clear", {});
    note("carrito vaciado");
    await refreshTotal();
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="brand">
          VAULT<span>.</span>
        </div>
        <div className="sub">Checkout terminal</div>

        <div className="section-label">Productos</div>
        <div className="row">
          <button className="ghost" onClick={() => addItem("KEY")}>
            + Keyboard $120
          </button>
          <button className="ghost" onClick={() => addItem("MSE")}>
            + Mouse $45
          </button>
          <button className="ghost" onClick={() => addItem("PAD")}>
            + Desk Mat $25
          </button>
        </div>

        <div className="section-label">Acciones</div>
        <div className="row">
          <button className="ghost" onClick={() => applyCoupon("SAVE25")}>
            Aplicar SAVE25
          </button>
          <button className="ghost danger" onClick={clearCart}>
            Vaciar carrito
          </button>
        </div>

        <button onClick={refreshTotal}>Recalcular total</button>

        {snapshot && (
          <div className="totals">
            <div className="line">
              <span>Items</span>
              <span>{snapshot.items.reduce((n, i) => n + i.qty, 0)}</span>
            </div>
            <div className="line">
              <span>Subtotal</span>
              <span>${snapshot.subtotal}</span>
            </div>
            <div className="line">
              <span>
                Descuento{" "}
                {snapshot.couponCode ? `(${snapshot.couponCode})` : ""}
              </span>
              <span>
                -${snapshot.discount} ({snapshot.discountPct}%)
              </span>
            </div>
            <div className="line total">
              <span>Total</span>
              <span>${snapshot.total}</span>
            </div>
          </div>
        )}

        <div className="hint">
          session: <code>{SESSION_ID}</code>
          <br />
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

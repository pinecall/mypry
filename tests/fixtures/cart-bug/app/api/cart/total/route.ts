import { NextRequest, NextResponse } from "next/server";
import { getCart } from "@/lib/cart-store";

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json();
  const cart = getCart(sessionId);

  // <-- BUEN SITIO PARA UN BREAKPOINT: inspeccionar `cart` aquí.
  const subtotal = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);

  // El cálculo del descuento es correcto: aplica discountPct sobre el subtotal.
  const discount = subtotal * (cart.discountPct / 100);
  const total = subtotal - discount;

  return NextResponse.json({
    items: cart.items,
    subtotal,
    discountPct: cart.discountPct,
    couponCode: cart.couponCode,
    discount,
    total,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getCart, CATALOG } from "@/lib/cart-store";

export async function POST(req: NextRequest) {
  const { sessionId, sku } = await req.json();
  const product = CATALOG[sku];

  if (!product) {
    return NextResponse.json({ error: "Unknown SKU" }, { status: 400 });
  }

  const cart = getCart(sessionId);
  const existing = cart.items.find((i) => i.sku === sku);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.items.push({ sku, name: product.name, price: product.price, qty: 1 });
  }

  return NextResponse.json({ items: cart.items });
}

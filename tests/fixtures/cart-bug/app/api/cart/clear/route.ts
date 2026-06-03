import { NextRequest, NextResponse } from "next/server";
import { clearCart, getCart } from "@/lib/cart-store";

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json();
  clearCart(sessionId);
  return NextResponse.json({ items: getCart(sessionId).items });
}

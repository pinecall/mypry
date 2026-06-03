import { NextRequest, NextResponse } from "next/server";
import { getCart, COUPONS } from "@/lib/cart-store";

export async function POST(req: NextRequest) {
  const { sessionId, code } = await req.json();
  const pct = COUPONS[code];

  if (pct === undefined) {
    return NextResponse.json({ error: "Invalid coupon" }, { status: 400 });
  }

  const cart = getCart(sessionId);
  cart.discountPct = pct;
  cart.couponCode = code;

  return NextResponse.json({ couponCode: code, discountPct: pct });
}

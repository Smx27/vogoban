import { NextResponse } from 'next/server';
import { listOrders } from '@/lib/gateway-client';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await listOrders());
}

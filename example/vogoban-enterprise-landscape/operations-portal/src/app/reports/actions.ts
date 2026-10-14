'use server';

import { revalidatePath } from 'next/cache';
import { requestReport } from '@/lib/reporting-client';

export async function requestOrdersSummaryReport(): Promise<void> {
  await requestReport('orders-summary', 'operations-portal');
  revalidatePath('/reports');
}

import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { quotationPropertyFields, quotationScheduleAmounts } from '@dct-crm/shared';
import { renderQuotationPdf } from './quotationPdf';

function pageText(pdf: Buffer): string[] {
  const source = pdf.toString('latin1');
  const pages: string[] = [];
  const streams = source.matchAll(/stream\r?\n([\s\S]*?)endstream/g);
  for (const match of streams) {
    const body = Buffer.from(match[1], 'latin1');
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(body);
    } catch {
      continue;
    }
    const text = inflated.toString('latin1');
    if (!text.includes('BT')) continue;
    const visible = [...text.matchAll(/<([0-9A-Fa-f]+)>/g)]
      .map((item) => Buffer.from(item[1], 'hex').toString('latin1'))
      .join('');
    pages.push(visible);
  }
  return pages;
}

const quotation = {
  companyName: 'DCT Real Estate',
  companyAddress: 'Tambaram, Chennai',
  companyPhone: '044 4000 0000',
  companyEmail: 'hello@dct.example',
  quotationNumber: 'QT-2026-000214',
  quotationDate: new Date('2026-10-17T10:00:00.000Z'),
  status: 'CONFIRMED',
  customerName: 'Asha Sharma',
  customerPhone: null,
  customerEmail: 'asha@example.com',
  customerAddress: null,
  projectName: 'DCT Heights',
  projectAddress: 'Noothanchery, Tambaram',
  pricePerSqFt: 1000,
  basePrice: 1000000,
  plcAmount: 25000,
  discountAmount: 10000,
  totalPrice: 1015000,
  paymentPlanName: 'Construction linked',
  installments: [
    { milestone: 'On confirmation', percentage: 10, dueDays: 0 },
    { milestone: 'On foundation', percentage: 25, dueDays: 60 },
    { milestone: 'On possession', percentage: 65, dueDays: 365 },
  ],
  terms: 'Prices follow the saved quotation. This note is optional.',
  preparedBy: 'System Admin',
};

describe('quotation PDF data', () => {
  it('describes an apartment by block, floor, and flat number', () => {
    expect(quotationPropertyFields({
      unitType: 'Apartment',
      unitNumber: 'Unit 1',
      block: 'Block 1',
      floor: 2,
      area: 980,
    })).toEqual([
      { label: 'Property type', value: 'Apartment' },
      { label: 'Block', value: 'Block 1' },
      { label: 'Floor', value: 'Floor 2' },
      { label: 'Unit number', value: 'Unit 1' },
    ]);
  });

  it('describes a plot by plot number and land area, and leaves missing values blank', () => {
    expect(quotationPropertyFields({ unitType: 'Plot', unitNumber: 'P-12', area: 1200 })).toEqual([
      { label: 'Property type', value: 'Plot' },
      { label: 'Plot number', value: 'P-12' },
      { label: 'Land area', value: '1,200 sq ft' },
    ]);
    expect(quotationPropertyFields({ unitType: 'Villa', unitNumber: '', area: null })).toEqual([
      { label: 'Property type', value: 'Villa' },
      { label: 'Villa number', value: '—' },
      { label: 'Built-up / land area', value: '—' },
    ]);
  });

  it('allocates the payment schedule so the amounts equal the saved grand total', () => {
    const amounts = quotationScheduleAmounts(1015000, [10, 25, 65]);
    expect(amounts).toEqual([101500, 253750, 659750]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(1015000);
  });

  it('renders an A4 quotation PDF from the saved figures', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      unitType: 'Apartment',
      unitNumber: 'Unit 1',
      block: 'Block 1',
      floor: 2,
      area: 1000,
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) || [];
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThan(4);
  });

  it('renders the quotation date in the configured tenant timezone', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      quotationDate: new Date('2026-10-17T01:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });

    expect(pageText(pdf).join(' ')).toContain('16 Oct 2026');
  });

  it('shows day-based payment timing and clearly excludes unconfigured taxes', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      installments: [
        { milestone: 'Booking token', percentage: 10, dueDays: 0 },
        { milestone: 'Registration', percentage: 90, dueDays: 60 },
      ],
    });

    const text = pageText(pdf).join(' ');
    expect(text).toContain('After 60 days');
    expect(text).toContain('No tax configuration is available');
    expect(text).toContain('Not included');
  });

  it('continues to render historical month-based installment snapshots', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      installments: [
        { milestone: 'Booking token', percentage: 10, dueMonths: 0 },
        { milestone: 'Registration', percentage: 90, dueMonths: 2 },
      ],
    });

    expect(pageText(pdf).join(' ')).toContain('After 2 months');
  });

  it('keeps the payment schedule heading on the same page as its rows', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      customerAddress: 'India',
      unitType: 'Penthouse',
      unitNumber: 'DCTParadise-U004',
      area: 1200,
      installments: [
        { milestone: 'Booking token', percentage: 10, dueDays: 0 },
        { milestone: 'Registration', percentage: 90, dueDays: 0 },
      ],
    });
    const schedulePage = pageText(pdf).find((page) => page.includes('Payment schedule'));
    expect(schedulePage).toContain('Milestone');
    expect(schedulePage).toContain('Booking token');
    expect(schedulePage).toContain('Registration');
  });

  it('repeats the payment schedule heading when rows continue on the next page', async () => {
    const pdf = await renderQuotationPdf({
      ...quotation,
      installments: Array.from({ length: 32 }, (_, index) => ({
        milestone: `Step ${String(index + 1).padStart(2, '0')}`,
        percentage: index === 31 ? 69 : 1,
        dueDays: index * 10,
      })),
    });
    const pages = pageText(pdf);
    const first = pages.find((page) => page.includes('Step 01'));
    const last = pages.find((page) => page.includes('Step 32'));
    expect(first).toContain('Payment schedule');
    expect(first).toContain('Milestone');
    expect(last).toContain('Milestone');
    expect(last).not.toBe(first);
  });
});

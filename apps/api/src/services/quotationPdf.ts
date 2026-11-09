import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { formatCRMDate, quotationDueLabel, quotationPropertyFields, quotationScheduleAmounts } from '@dct-crm/shared';

const NAVY = '#0b2545';
const GOLD = '#c6a15b';
const INK = '#142033';
const MUTED = '#64748b';
const LINE = '#e4d7bc';
const PAPER = '#fbf7f0';
const WHITE = '#ffffff';
const LEFT = 36;
const RIGHT = 559;
const WIDTH = RIGHT - LEFT;
const PAD = 8;
const COL_GAP = 12;
const INNER_LEFT = LEFT + PAD;
const INNER_RIGHT = RIGHT - PAD;
const AMOUNT_WIDTH = 96;
const AMOUNT_X = INNER_RIGHT - AMOUNT_WIDTH;
const DETAIL_WIDTH = 168;
const DETAIL_X = AMOUNT_X - COL_GAP - DETAIL_WIDTH;
const DESCRIPTION_WIDTH = DETAIL_X - COL_GAP - INNER_LEFT;
const SHARE_WIDTH = 40;
const SHARE_X = AMOUNT_X - COL_GAP - SHARE_WIDTH;
const DUE_WIDTH = 90;
const DUE_X = SHARE_X - COL_GAP - DUE_WIDTH;
const MILESTONE_WIDTH = DUE_X - COL_GAP - INNER_LEFT;
const PAGE1_TOP = 236;
const LATER_TOP = 92;
const CONTENT_BOTTOM = 772;
const BANNER_PATH = path.resolve(__dirname, '../../assets/dct-construction-banner.jpg');

function bannerImage(): Buffer | null {
  try {
    return fs.readFileSync(BANNER_PATH);
  } catch (error) {
    console.error('Could not read the DCT Construction quotation banner:', error);
    return null;
  }
}

export interface QuotationPdfInstallment {
  milestone: string;
  percentage: number;
  dueMonths?: number | null;
  dueDays?: number | null;
}

export interface QuotationPdfInput {
  companyName: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyEmail?: string | null;
  companyWebsite?: string | null;
  logo?: Buffer | null;
  quotationNumber: string;
  quotationDate: Date;
  timeZone?: string | null;
  status?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  projectName?: string | null;
  projectAddress?: string | null;
  unitType?: string | null;
  unitNumber?: string | null;
  block?: string | null;
  floor?: number | null;
  area?: number | null;
  pricePerSqFt: number;
  basePrice: number;
  plcAmount: number;
  discountAmount: number;
  totalPrice: number;
  paymentPlanName?: string | null;
  installments: QuotationPdfInstallment[];
  terms?: string | null;
  preparedBy?: string | null;
  organizationType?: string | null;
  documentLabel?: string | null;
  headerNumber?: string | null;
  bookingNumber?: string | null;
  bookingAmount?: number | null;
  applicants?: Array<{
    title: string;
    fields: Array<{ label: string; value: string }>;
    photo?: Buffer | null;
  }>;
}

const blank = '—';

function text(value?: string | number | null): string {
  if (value == null) return blank;
  const cleaned = String(value).trim();
  return cleaned || blank;
}

function inr(amount: number): string {
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
  return `INR ${formatted}`;
}

function quotationDate(value: Date, timeZone?: string | null): string {
  return formatCRMDate(value, timeZone || undefined);
}

function paintPaper(document: PDFKit.PDFDocument) {
  document.save();
  document.rect(0, 0, document.page.width, document.page.height).fill(WHITE);
  document.restore();
}

function ensureSpace(document: PDFKit.PDFDocument, height: number) {
  if (document.y + height <= CONTENT_BOTTOM) return;
  document.addPage();
  document.y = LATER_TOP;
}

function sectionTitle(document: PDFKit.PDFDocument, title: string) {
  ensureSpace(document, 28);
  const top = document.y;
  document.rect(LEFT, top, 3, 14).fill(GOLD);
  document.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
    .text(title, INNER_LEFT, top, { width: INNER_RIGHT - INNER_LEFT, lineBreak: false });
  document.y = top + 18;
}

function fieldGrid(document: PDFKit.PDFDocument, fields: Array<{ label: string; value: string }>) {
  const gap = 10;
  const cellWidth = (WIDTH - gap) / 2;
  for (let index = 0; index < fields.length; index += 2) {
    const row = fields.slice(index, index + 2);
    ensureSpace(document, 36);
    const top = document.y;
    row.forEach((field, cellIndex) => {
      const single = row.length === 1;
      const left = single ? LEFT : LEFT + cellIndex * (cellWidth + gap);
      const width = single ? WIDTH : cellWidth;
      document.roundedRect(left, top, width, 32, 3).fillAndStroke(PAPER, LINE);
      document.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(field.label.toUpperCase(), left + PAD, top + 5, { width: width - PAD * 2, lineBreak: false });
      document.font('Helvetica-Bold').fontSize(9).fillColor(INK)
        .text(field.value, left + PAD, top + 16, { width: width - PAD * 2, height: 12, ellipsis: true });
    });
    document.y = top + 36;
  }
}

interface PdfColumn {
  label: string;
  x: number;
  width: number;
  align?: PDFKit.Mixins.TextOptions['align'];
}

function drawTable(
  document: PDFKit.PDFDocument,
  columns: PdfColumn[],
  rows: Array<{
    cells: Array<{ text: string; bold?: boolean }>;
    fill?: string;
    color?: string;
    height?: number;
    span?: boolean;
  }>,
) {
  let drawingHeader = false;
  const drawHeader = () => {
    if (drawingHeader) return;
    drawingHeader = true;
    if (document.y + 20 > CONTENT_BOTTOM) {
      document.addPage();
      document.y = LATER_TOP;
    }
    const top = document.y;
    document.rect(LEFT, top, WIDTH, 20).fill(NAVY);
    document.font('Helvetica-Bold').fontSize(8).fillColor(WHITE);
    columns.forEach((column) => {
      document.text(column.label, column.x + PAD, top + 6, {
        width: column.width - PAD * 2,
        align: column.align,
        lineBreak: false,
      });
    });
    document.y = top + 20;
    drawingHeader = false;
  };

  drawHeader();
  rows.forEach((row) => {
    const height = row.height ?? 22;
    if (document.y + height > CONTENT_BOTTOM) {
      document.addPage();
      document.y = LATER_TOP;
      drawHeader();
    }
    const top = document.y;
    if (row.fill) document.rect(LEFT, top, WIDTH, height).fill(row.fill);
    document.moveTo(LEFT, top + height).lineTo(RIGHT, top + height).strokeColor(LINE).stroke();
    if (row.span) {
      const cell = row.cells[0];
      document.font(cell?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(row.color || INK)
        .text(cell?.text || '', INNER_LEFT, top + 6, { width: INNER_RIGHT - INNER_LEFT, height: height - 8, ellipsis: true });
    } else {
      row.cells.forEach((cell, index) => {
        const column = columns[index];
        if (!column) return;
        document.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(row.color || INK)
          .text(cell.text, column.x + PAD, top + 6, {
            width: column.width - PAD * 2,
            align: column.align,
            height: height - 8,
            ellipsis: true,
          });
      });
    }
    document.y = top + height;
  });
}

function drawBody(document: PDFKit.PDFDocument, input: QuotationPdfInput) {
  document.y = PAGE1_TOP;
  if (input.bookingNumber) {
    sectionTitle(document, 'Booking');
    fieldGrid(document, [
      { label: 'Booking number', value: text(input.bookingNumber) },
      { label: 'Booking amount', value: input.bookingAmount == null ? blank : inr(input.bookingAmount) },
      { label: 'Quotation number', value: text(input.quotationNumber) },
      { label: 'Status', value: text(input.status) },
    ]);
  }

  sectionTitle(document, 'Customer information');
  fieldGrid(document, [
    { label: 'Customer', value: text(input.customerName) },
    { label: 'Organization type', value: text(input.organizationType) },
    { label: 'Phone', value: text(input.customerPhone) },
    { label: 'Email', value: text(input.customerEmail) },
    { label: 'Address', value: text(input.customerAddress) },
  ]);

  sectionTitle(document, 'Project details');
  fieldGrid(document, [
    { label: 'Project', value: text(input.projectName) },
    { label: 'Project location', value: text(input.projectAddress) },
    { label: 'Quotation number', value: text(input.quotationNumber) },
    { label: 'Quotation date', value: quotationDate(input.quotationDate, input.timeZone) },
  ]);

  sectionTitle(document, 'Property');
  fieldGrid(document, quotationPropertyFields({
    unitType: input.unitType,
    unitNumber: input.unitNumber,
    block: input.block,
    floor: input.floor,
    area: input.area,
  }));

  sectionTitle(document, 'Price breakdown');
  const priceColumns: PdfColumn[] = [
    { label: 'Description', x: INNER_LEFT, width: DESCRIPTION_WIDTH },
    { label: 'Details', x: DETAIL_X, width: DETAIL_WIDTH },
    { label: 'Amount', x: AMOUNT_X, width: AMOUNT_WIDTH, align: 'right' },
  ];
  const rate = Number.isFinite(input.pricePerSqFt) ? inr(input.pricePerSqFt) : blank;
  const areaLabel = input.area == null || !Number.isFinite(input.area) ? blank : `${input.area.toLocaleString('en-IN')} sq ft`;
  const subtotal = input.basePrice + input.plcAmount;
  const discountPercent = input.basePrice > 0
    ? Number((input.discountAmount / input.basePrice * 100).toFixed(2))
    : 0;
  const priceRows: Array<[string, string, string]> = [
    ['Base price', `${areaLabel} × ${rate} / sq ft`, inr(input.basePrice)],
    ['Additional charges', 'PLC and other charges', inr(input.plcAmount)],
    ['Subtotal', 'Base price plus additional charges', inr(subtotal)],
    ['Discount', `${discountPercent}% of unit base price`, input.discountAmount > 0 ? `-${inr(input.discountAmount)}` : inr(0)],
    ['Taxes', 'No tax configuration is available', 'Not included'],
  ];
  drawTable(document, priceColumns, [
    ...priceRows.map((row, index) => ({
      cells: [{ text: row[0] }, { text: row[1] }, { text: row[2] }],
      fill: index % 2 === 0 ? WHITE : PAPER,
    })),
    {
      cells: [
        { text: 'Grand total', bold: true },
        { text: 'Amount payable', bold: true },
        { text: inr(input.totalPrice), bold: true },
      ],
      fill: NAVY,
      color: WHITE,
      height: 24,
    },
    ...(input.bookingAmount == null ? [] : [{
      cells: [
        { text: 'Booking amount', bold: true },
        { text: 'Received with this booking' },
        { text: inr(input.bookingAmount), bold: true },
      ],
    }]),
  ]);

  const scheduleColumns: PdfColumn[] = [
    { label: 'Milestone', x: INNER_LEFT, width: MILESTONE_WIDTH },
    { label: 'Due', x: DUE_X, width: DUE_WIDTH },
    { label: 'Share', x: SHARE_X, width: SHARE_WIDTH, align: 'right' },
    { label: 'Amount', x: AMOUNT_X, width: AMOUNT_WIDTH, align: 'right' },
  ];
  const scheduleRowCount = Math.min(Math.max(input.installments.length, 1), 3);
  ensureSpace(document, 52 + 22 * scheduleRowCount);
  sectionTitle(document, 'Payment schedule');
  const planTop = document.y;
  document.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(text(input.paymentPlanName), INNER_LEFT, planTop, {
      width: INNER_RIGHT - INNER_LEFT,
      height: 12,
      ellipsis: true,
    });
  document.y = planTop + 14;
  const amounts = quotationScheduleAmounts(input.totalPrice, input.installments.map((item) => item.percentage));
  drawTable(
    document,
    scheduleColumns,
    input.installments.length
      ? input.installments.map((installment, index) => ({
        cells: [
          { text: text(installment.milestone) },
          { text: quotationDueLabel(installment) },
          { text: `${installment.percentage}%` },
          { text: inr(amounts[index] || 0) },
        ],
        fill: index % 2 === 0 ? WHITE : PAPER,
      }))
      : [{
        cells: [{ text: 'No payment schedule was recorded on this quotation.' }],
        span: true,
      }],
  );

  input.applicants?.forEach((applicant) => {
    sectionTitle(document, applicant.title);
    if (applicant.photo) {
      ensureSpace(document, 62);
      const photoTop = document.y;
      try {
        document.image(applicant.photo, LEFT, photoTop, { fit: [48, 52] });
        document.font('Helvetica').fontSize(7).fillColor(MUTED)
          .text('Photo', LEFT, photoTop + 54, { width: 48, align: 'center', lineBreak: false });
      } catch (error) {
        console.error(`Could not place the ${applicant.title} photo:`, error);
      }
      document.y = photoTop + 68;
    }
    fieldGrid(document, applicant.fields);
  });

  sectionTitle(document, 'Terms and conditions');
  const terms = input.terms?.trim() || 'No additional terms were recorded on this quotation.';
  terms.split(/\n/).forEach((paragraph) => drawParagraph(document, paragraph));

  const signatureHeight = 108;
  ensureSpace(document, signatureHeight);
  const top = document.y + 6;
  const boxWidth = (WIDTH - 20) / 3;
  [
    { title: 'Customer signature', name: text(input.customerName) },
    { title: 'Authorized signature', name: text(input.preparedBy) },
  ].forEach((box, side) => {
    const left = LEFT + side * (boxWidth + 10);
    document.roundedRect(left, top, boxWidth, 96, 4).strokeColor(LINE).stroke();
    document.font('Helvetica-Bold').fontSize(8).fillColor(NAVY)
      .text(box.title, left + 10, top + 10, { width: boxWidth - 20, lineBreak: false });
    document.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(box.name, left + 10, top + 26, { width: boxWidth - 20, height: 12, ellipsis: true });
    document.moveTo(left + 10, top + 72).lineTo(left + boxWidth - 10, top + 72).strokeColor(GOLD).stroke();
    document.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text('Signature and date', left + 10, top + 76, { width: boxWidth - 20, lineBreak: false });
  });
  drawSeal(document, LEFT + 2 * (boxWidth + 10), top, boxWidth, 96, text(input.companyName));
  document.y = top + 104;
}

function drawSeal(
  document: PDFKit.PDFDocument,
  left: number,
  top: number,
  width: number,
  height: number,
  companyName: string,
) {
  document.roundedRect(left, top, width, height, 4).strokeColor(LINE).stroke();
  const size = 62;
  const cx = left + width / 2;
  const cy = top + 40;
  document.circle(cx, cy, size / 2).lineWidth(1.6).strokeColor(GOLD).stroke();
  document.circle(cx, cy, size / 2 - 4).lineWidth(0.7).strokeColor(NAVY).stroke();
  const initials = companyName === blank
    ? '—'
    : companyName.split(/\s+/).map((word) => word[0] || '').join('').slice(0, 4).toUpperCase();
  document.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
    .text(initials, left + 8, cy - 8, { width: width - 16, align: 'center', lineBreak: false });
  document.font('Helvetica').fontSize(6.5).fillColor(GOLD)
    .text('COMPANY SEAL', left + 8, cy + 6, { width: width - 16, align: 'center', lineBreak: false });
  document.font('Helvetica').fontSize(7).fillColor(MUTED)
    .text(companyName, left + 8, top + height - 16, { width: width - 16, align: 'center', height: 10, ellipsis: true });
}

function drawParagraph(document: PDFKit.PDFDocument, paragraph: string) {
  const textWidth = INNER_RIGHT - INNER_LEFT;
  const words = paragraph.trim().split(/\s+/).filter(Boolean);
  document.font('Helvetica').fontSize(9).fillColor(INK);
  if (!words.length) {
    document.y += 8;
    return;
  }
  let line = '';
  const flush = () => {
    if (!line) return;
    ensureSpace(document, 14);
    document.font('Helvetica').fontSize(9).fillColor(INK)
      .text(line, INNER_LEFT, document.y, { width: textWidth, lineBreak: false });
    document.y += 13;
    line = '';
  };
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (document.widthOfString(next) > textWidth && line) {
      flush();
      line = word;
    } else {
      line = next;
    }
  });
  flush();
  document.y += 3;
}

function drawChrome(document: PDFKit.PDFDocument, input: QuotationPdfInput, pageNumber: number, pageCount: number) {
  const pageWidth = document.page.width;
  const contact = [input.companyAddress, input.companyPhone, input.companyEmail, input.companyWebsite]
    .map((item) => item?.trim())
    .filter(Boolean)
    .join('  ·  ');
  document.y = 24;
  document.x = LEFT;
  document.save();
  if (pageNumber === 1) {
    const banner = bannerImage();
    if (banner) {
      document.save();
      document.rect(0, 0, pageWidth, 168).clip();
      document.image(banner, 0, 0, { width: pageWidth });
      document.restore();
    } else {
      document.rect(0, 0, pageWidth, 168).fill(NAVY);
    }
    document.rect(0, 168, pageWidth, 4).fill(GOLD);
    document.rect(0, 172, pageWidth, 48).fill(NAVY);
    if (input.logo) {
      try {
        document.roundedRect(28, 180, 34, 34, 3).fill(WHITE);
        document.image(input.logo, 30, 182, { fit: [30, 30] });
      } catch (error) {
        console.error('Could not place the company logo on the quotation PDF:', error);
      }
    }
    const nameLeft = input.logo ? 70 : LEFT;
    const metaWidth = 210;
    const metaX = RIGHT - metaWidth;
    const nameWidth = Math.max(120, metaX - 16 - nameLeft);
    document.font('Helvetica-Bold').fontSize(12).fillColor(WHITE)
      .text(text(input.companyName), nameLeft, 180, { width: nameWidth, height: 16, ellipsis: true });
    document.font('Helvetica').fontSize(7).fillColor('#f3e6c8')
      .text(contact || 'Company contact details are not on file', nameLeft, 198, { width: nameWidth, height: 18 });
    document.font('Helvetica').fontSize(7).fillColor(GOLD)
      .text(text(input.documentLabel || 'QUOTATION'), metaX, 178, { width: metaWidth, align: 'right', lineBreak: false });
    document.font('Helvetica-Bold').fontSize(11).fillColor(WHITE)
      .text(input.headerNumber || input.quotationNumber, metaX, 190, { width: metaWidth, align: 'right', height: 14, ellipsis: true });
    document.font('Helvetica').fontSize(7.5).fillColor('#f3e6c8')
      .text(`${quotationDate(input.quotationDate, input.timeZone)}  ·  ${text(input.status).replace(/_/g, ' ')}`, metaX, 206, { width: metaWidth, align: 'right', lineBreak: false });
  } else {
    document.rect(0, 0, pageWidth, 64).fill(NAVY);
    document.rect(0, 64, pageWidth, 3).fill(GOLD);
    if (input.logo) {
      try {
        document.image(input.logo, 28, 16, { fit: [32, 32] });
      } catch (error) {
        console.error('Could not place the company logo on the quotation PDF:', error);
      }
    }
    const nameLeft = input.logo ? 68 : LEFT;
    const metaWidth = 210;
    const metaX = RIGHT - metaWidth;
    const nameWidth = Math.max(120, metaX - 16 - nameLeft);
    document.font('Helvetica-Bold').fontSize(11).fillColor(WHITE)
      .text(text(input.companyName), nameLeft, 16, { width: nameWidth, height: 14, ellipsis: true });
    document.font('Helvetica').fontSize(7).fillColor('#f3e6c8')
      .text(contact || 'Company contact details are not on file', nameLeft, 34, { width: nameWidth, height: 18 });
    document.font('Helvetica-Bold').fontSize(10).fillColor(WHITE)
      .text(input.headerNumber || input.quotationNumber, metaX, 18, { width: metaWidth, align: 'right', height: 14, ellipsis: true });
    document.font('Helvetica').fontSize(7.5).fillColor(GOLD)
      .text(quotationDate(input.quotationDate, input.timeZone), metaX, 36, { width: metaWidth, align: 'right', lineBreak: false });
  }

  document.rect(0, 802, pageWidth, 40).fill(NAVY);
  document.rect(0, 802, pageWidth, 2).fill(GOLD);
  document.font('Helvetica').fontSize(8).fillColor('#f3e6c8')
    .text(`${text(input.companyName)}  ·  ${contact || input.headerNumber || input.quotationNumber}`, LEFT, 816, { width: RIGHT - LEFT - 100, height: 12, ellipsis: true });
  document.text(`Page ${pageNumber} of ${pageCount}`, RIGHT - 90, 816, { width: 90, align: 'right', lineBreak: false });
  document.restore();
}

export function renderQuotationPdf(input: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('pageAdded', () => {
      const y = document.y;
      paintPaper(document);
      document.y = y;
    });
    paintPaper(document);
    drawBody(document, input);
    const range = document.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      document.switchToPage(range.start + index);
      drawChrome(document, input, index + 1, range.count);
    }
    document.end();
  });
}

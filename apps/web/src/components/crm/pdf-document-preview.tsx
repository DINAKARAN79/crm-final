"use client";

import * as React from "react";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface PdfPreviewDocument {
  number: string;
  url: string;
  eyebrow?: string;
  description?: string;
}

export function PdfDocumentPreview({
  preview,
  onClose,
}: {
  preview: PdfPreviewDocument | null;
  onClose: () => void;
}) {
  const frame = React.useRef<HTMLIFrameElement>(null);

  return (
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] !max-w-[100vw] flex-col gap-0 overflow-hidden rounded-none bg-white p-0 sm:h-[92vh] sm:max-h-[92vh] sm:!max-w-5xl sm:rounded-lg">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-[#c6a15b] bg-white px-5 py-4 pr-12">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#c6a15b]">
              {preview?.eyebrow || "Document preview"}
            </p>
            <DialogTitle className="text-lg text-[#0b2545]">{preview?.number}</DialogTitle>
            <DialogDescription>
              {preview?.description || "Download and print use the saved PDF."}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="bg-[#0b2545] text-white hover:bg-[#08182d]"
              onClick={() => {
                if (!preview) return;
                const anchor = document.createElement("a");
                anchor.href = preview.url;
                anchor.download = `${preview.number}.pdf`;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
              }}
            >
              <Download className="mr-1.5 h-4 w-4" />Download PDF
            </Button>
            <Button
              type="button"
              size="sm"
              className="bg-[#c6a15b] text-[#0b2545] hover:bg-[#b58d45]"
              onClick={() => {
                frame.current?.contentWindow?.focus();
                frame.current?.contentWindow?.print();
              }}
            >
              <Printer className="mr-1.5 h-4 w-4" />Print
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        {preview && (
          <iframe
            ref={frame}
            title={`${preview.number} PDF`}
            src={preview.url}
            className="block min-h-0 w-full flex-1 bg-slate-100"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

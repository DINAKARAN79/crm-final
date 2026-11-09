"use client";

import * as React from "react";
import { Loader2, Plus, RefreshCw, StickyNote } from "lucide-react";
import { notesApi } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface StickyNotesCardProps {
  recordId: string;
  canAdd?: boolean;
  openSignal?: number;
}

interface ParsedNote {
  number: string;
  author: string;
  timestamp: string;
  content: string;
}

function parseNoteBlock(block: string): ParsedNote | null {
  const match = block.match(/^Note (\d+): \((.*?)\) - \((.*?)\):\r?\n([\s\S]*)$/);
  if (!match) return null;
  return {
    number: match[1],
    author: match[2],
    timestamp: match[3],
    content: match[4],
  };
}

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function orderNoteBlocksNewestFirst(notes: string): string[] {
  return notes
    ? notes.split(/\n\n(?=Note \d+:)/).map((block, index) => ({ block, index, parsed: parseNoteBlock(block) }))
      .sort((left, right) => {
        const leftNumber = left.parsed ? Number(left.parsed.number) : null;
        const rightNumber = right.parsed ? Number(right.parsed.number) : null;
        if (leftNumber === null || rightNumber === null) {
          if (leftNumber === null && rightNumber === null) return left.index - right.index;
          return leftNumber === null ? 1 : -1;
        }
        return rightNumber - leftNumber || left.index - right.index;
      })
      .map(({ block }) => block)
    : [];
}

export default function StickyNotesCard({ recordId, canAdd = true, openSignal = 0 }: StickyNotesCardProps) {
  const { toast } = useToast();
  const [notes, setNotes] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);

  React.useEffect(() => {
    if (openSignal > 0 && canAdd) setDialogOpen(true);
  }, [openSignal, canAdd]);

  const refreshNotes = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await notesApi.get(recordId);
      if (!response.data.success || !response.data.data) {
        throw new Error("Failed to fetch notes");
      }
      setNotes(response.data.data.notes || "");
    } catch {
      setLoadError("Unable to load notes. Please refresh to try again.");
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  React.useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  const saveNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) {
      toast({ title: "Validation", description: "Note cannot be empty.", variant: "destructive" });
      return;
    }
    if (savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    try {
      const response = await notesApi.add(recordId, content);
      if (!response.data.success) throw new Error("Unable to save note");
      setDialogOpen(false);
      setDraft("");
      toast({ title: "Success", description: "Note added successfully." });
      await refreshNotes();
    } catch {
      toast({
        title: "Unable to save note",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const noteBlocks = orderNoteBlocksNewestFirst(notes);

  return (
    <>
      <Card className="my-0 box-border w-full rounded-md border-slate-200 shadow-sm">
        <CardHeader className="flex min-h-[64px] flex-row items-center justify-between space-y-0 gap-3 border-b border-slate-200 bg-white p-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-orange-500">
              <StickyNote className="h-5 w-5 text-white" aria-hidden="true" />
            </span>
            <h2 className="text-[12px] font-semibold">Sticky Notes</h2>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full bg-[#08749f] text-white hover:bg-[#066487] hover:text-white"
              aria-label="Refresh notes"
              onClick={() => void refreshNotes()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
            {canAdd && (
              <Button type="button" size="sm" className="h-8 bg-[#d9ebf5] px-3 text-[10px] font-medium text-[#397b9b] shadow-none hover:bg-[#c9e1ef] hover:text-[#286b8d]" onClick={() => setDialogOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add Notes
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div
            className="max-h-[350px] min-h-0 space-y-3 overflow-y-auto px-1 py-1"
            aria-live="polite"
            aria-busy={loading}
          >
            {loading && !notes ? (
              <div className="flex min-h-12 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : loadError ? (
              <div role="alert" className="flex min-h-12 items-center justify-center text-center text-sm text-destructive">
                {loadError}
              </div>
            ) : noteBlocks.length === 0 ? (
              <div className="flex min-h-12 flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm font-medium">No notes available.</p>
                <p className="text-sm text-muted-foreground">Add a note to start the conversation history.</p>
              </div>
            ) : (
              noteBlocks.map((block, index) => {
                const parsed = parseNoteBlock(block);
                const content = parsed?.content || block;
                return (
                  <details key={`${index}-${block.slice(0, 24)}`} className="group rounded-md border border-slate-200 bg-white p-3">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-semibold text-blue-700 underline decoration-dotted underline-offset-2 group-open:no-underline">
                          {parsed ? `Note ${parsed.number}` : "Note"}
                        </span>
                        <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                          {content.replace(/\s+/g, " ").trim()}
                        </span>
                      </span>
                      {parsed && (
                        <time
                          dateTime={Number.isNaN(new Date(parsed.timestamp).getTime()) ? undefined : new Date(parsed.timestamp).toISOString()}
                          title={formatNoteDate(parsed.timestamp)}
                          className="shrink-0 text-right text-[10px] text-muted-foreground"
                        >
                          {parsed.author} · {formatNoteDate(parsed.timestamp)}
                        </time>
                      )}
                    </summary>
                    <div className="mt-2 border-t border-slate-100 pt-2">
                      {parsed && (
                        <p className="mb-1 text-[10px] text-muted-foreground">{parsed.author}</p>
                      )}
                      <p className="output-font whitespace-pre-wrap break-words text-[11px] font-medium leading-5">
                        {content}
                      </p>
                    </div>
                  </details>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!savingRef.current) setDialogOpen(open);
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
          <form onSubmit={saveNote}>
            <DialogHeader>
              <DialogTitle>Add New Note</DialogTitle>
              <DialogDescription>
                Add a note to this record&apos;s conversation history.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <label htmlFor="sticky-note-input" className="mb-2 block text-sm font-medium">
                Note
              </label>
              <Textarea
                id="sticky-note-input"
                autoFocus
                maxLength={5000}
                aria-required="true"
                rows={5}
                className="min-h-[100px] resize-y"
                placeholder="Enter your note here..."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={saving}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? "Saving..." : "Save Note"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

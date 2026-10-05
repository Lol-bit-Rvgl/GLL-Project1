"use client";

import { ExportMenu } from "@/components/ExportMenu";

import { clock, wordCount } from "@/lib/format";
import type { Block } from "@/lib/transcript";

export type HistoryProps = {
  blocks: readonly Block[];
  interim: string;
  language: string;
  endMs: number;
  onClear: () => void;
};

export function History({ blocks, interim, language, endMs, onClear }: HistoryProps) {
  const allBlocks = [...blocks];
  const hasBookmarks = allBlocks.some((b) => b.bookmarked);
  const totalWords = wordCount(
    [...allBlocks.map((b) => b.text), interim].join(" "),
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-neon/12 bg-panel/40 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-snow">Sesiones y Archivo</h2>
            <p className="text-xs text-slate-ink">
              {allBlocks.length} frases Â· {totalWords} palabras Â· {endMs ? clock(endMs) : "00:00:00"}
            </p>
          </div>
          <ExportMenu
            blocks={blocks}
            interim={interim}
            language={language}
            endMs={endMs}
            onClear={onClear}
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        {allBlocks.length === 0 && interim.trim() === "" && (
          <p className="mt-8 text-center text-xs text-slate-ink">
            AÃºn no hay transcripciones guardadas en esta sesiÃ³n.
          </p>
        )}
        {hasBookmarks && (
          <section className="mb-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-flare">
              Marcadores
            </h3>
            {allBlocks
              .filter((b) => b.bookmarked)
              .map((block) => (
                <div
                  key={block.id}
                  className="rounded-md border border-flare/30 bg-flare/[0.07] p-2 text-sm text-snow"
                >
                  <span className="font-mono text-[10px] text-flare tabular-nums">
                    {clock(block.startMs)}
                  </span>{" "}
                  {block.text}
                </div>
              ))}
          </section>
        )}
        <section className="space-y-2">
          {allBlocks.map((block) => (
            <div
              key={block.id}
              className={`rounded-md border border-neon/10 bg-raised/40 p-2 text-sm text-snow ${
                block.bookmarked ? "border-flare/40" : ""
              }`}
            >
              <span className="font-mono text-[10px] text-slate-ink tabular-nums">
                {clock(block.startMs)}
              </span>{" "}
              {block.text}
            </div>
          ))}
          {interim.trim() !== "" && (
            <div className="rounded-md border border-dashed border-neon/30 bg-neon/[0.05] p-2 text-sm text-snow/80">
              {interim}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}



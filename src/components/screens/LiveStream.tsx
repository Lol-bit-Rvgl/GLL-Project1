"use client";

import { ExportMenu } from "@/components/ExportMenu";
import { TranscriptStream } from "@/components/TranscriptStream";
import { VuMeter } from "@/components/VuMeter";

import type { Block } from "@/lib/transcript";

export type LiveStreamProps = {
  blocks: readonly Block[];
  interim: string;
  speaking: boolean;
  stickToBottom: boolean;
  onStickChange: (stick: boolean) => void;
  engineReady: boolean;
  capturing: boolean;
  query: string;
  setQuery: (query: string) => void;
  searchOpen: boolean;
  matchCount: number;
  onToggleBookmark: (id: number) => void;
  onDismissSearch: () => void;
  language: string;
  endMs: number;
  onClear: () => void;
};

export function LiveStream(props: LiveStreamProps) {
  return (
    <>
      <TranscriptStream
        blocks={props.blocks}
        interim={props.interim}
        speaking={props.speaking}
        stickToBottom={props.stickToBottom}
        onStickChange={props.onStickChange}
        engineReady={props.engineReady}
        capturing={props.capturing}
        query={props.query}
        setQuery={props.setQuery}
        searchOpen={props.searchOpen}
        matchCount={props.matchCount}
        onToggleBookmark={props.onToggleBookmark}
        onDismissSearch={props.onDismissSearch}
      />

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neon/12 bg-panel/60 px-6 py-2.5 backdrop-blur">
        <VuMeter active={props.capturing} noiseFloorDb={-90} />
        <ExportMenu
          blocks={props.blocks}
          interim={props.interim}
          language={props.language}
          endMs={props.endMs}
          onClear={props.onClear}
        />
      </footer>
    </>
  );
}




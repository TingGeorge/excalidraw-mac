// Exported by the build (see vite.config.ts): Excalidraw's command palette.
import "@excalidraw/excalidraw";
import type { JSX, ReactNode } from "react";

declare module "@excalidraw/excalidraw" {
  export type MacCommandPaletteItem = {
    label: string;
    category: string;
    keywords?: string[];
    icon?: ReactNode;
    shortcut?: string;
    perform: () => void;
  };
  export const CommandPalette: (props: { customCommandPaletteItems?: MacCommandPaletteItem[] }) => JSX.Element | null;
}

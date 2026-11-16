export type SourceProjection =
  | {
      kind: "markdown";
      mediaType: "text/markdown";
      contentRef: string;
      sha256: string;
      bytes: number;
    }
  | {
      kind: "image";
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      contentRef: string;
      sha256: string;
      bytes: number;
    };

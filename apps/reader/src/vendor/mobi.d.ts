export function isMOBI(file: Blob): Promise<boolean>;
export interface MobiSection { id?: number; linear?: string; load?: () => Promise<string>; createDocument?: () => Promise<Document>; size?: number }
export interface MobiTocItem { label: string; href: string; subitems?: MobiTocItem[] }
export interface MobiBook {
  sections: MobiSection[];
  toc?: MobiTocItem[];
  dir?: string;
  metadata: { title?: string; author?: string[]; language?: string; description?: string; publisher?: string };
  getCover(): Promise<Blob | undefined>;
  resolveHref(href: string): Promise<{ index: number; anchor: (doc: Document) => Element | null } | undefined> | { index: number; anchor: (doc: Document) => Element | null } | undefined;
  destroy?(): void;
}
export class MOBI { constructor(o: { unzlib: (a: Uint8Array) => Promise<Uint8Array> }); open(file: Blob): Promise<MobiBook> }

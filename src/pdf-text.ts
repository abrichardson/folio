import { linesFromFragments } from '@/lib/import/pdf-lines';

// Extracts text lines from a PDF on this computer with pdf.js (bundled with the app, no
// network). pdf.js is loaded only when a PDF is opened. Pinned to 4.10: 5.x fails to read
// some Synchrony statement pages.
export async function pdfTextLines(bytes: Uint8Array): Promise<string[]> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const lines: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      lines.push(
        ...linesFromFragments(
          content.items.flatMap((item) =>
            'str' in item
              ? [{ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width }]
              : [],
          ),
        ),
      );
    }
    return lines;
  } finally {
    await doc.destroy();
  }
}

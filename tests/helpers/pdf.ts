/** A tiny valid PDF with one line of text per page. `streams` overrides a page's content stream object. */
export function simplePdf(pages: string[], streams: Record<number, Buffer> = {}, pageHeight = 792): Buffer {
  const objects: (string | Buffer)[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  pages.forEach((line, page) => {
    const pageObj = objects.length + 1;
    const content = `BT /F1 12 Tf 56 760 Td (${line}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Contents ${pageObj + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`);
    objects.push(streams[page] ?? `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(`${pageObj} 0 R`);
  });
  const font = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body.replace("FONT", String(font)), "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(chunks);
}

/** A FlateDecode content stream that inflates to `inflatedBytes` of spaces from a small input. */
export async function flateBomb(inflatedBytes: number): Promise<Buffer> {
  const { createDeflate } = await import("node:zlib");
  const deflate = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => { deflate.on("end", resolve); deflate.on("error", reject); });
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let written = 0; written < inflatedBytes; written += block.length) {
    if (!deflate.write(block)) await new Promise<void>((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  const data = Buffer.concat(out);
  return Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
}

/** A content stream object with `lines` lines of text from the top of a page `pageHeight` tall. */
export function textStream(lines: string[], pageHeight: number): Buffer {
  const content = `BT /F1 10 Tf 12 TL 56 ${pageHeight - 20} Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
  return Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "latin1");
}

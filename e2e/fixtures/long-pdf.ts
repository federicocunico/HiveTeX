/** A deterministic real PDF for rendering tests (not a LaTeX or product screenshot fixture). */
export function longPdf(count = 100): number[] {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const landscape = n === 51;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${landscape ? '842 595' : '595 842'}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const stream = `BT /F1 18 Tf 50 ${landscape ? 500 : 760} Td (Preview acceptance page ${n}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`;
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [n, object] of objects.entries()) { offsets.push(out.length); out += `${n + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Array.from(new TextEncoder().encode(out));
}

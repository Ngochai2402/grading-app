// ─────────────────────────────────────────────────────────────────────────────
// export.js — Xuất HTML + PDF (v3, tối giản)
//
// Thay đổi so với v2:
//   - Bỏ tham chiếu tới các field cũ đã xóa (nhan_xet_chung, loi_sai tổng, xep_loai
//     trong chi tiết câu, kiem_tra_toan_ven).
//   - Fix lỗi LaTeX compile:
//     · Xử lý triệt để emoji / ký tự đặc biệt trong cột HS (✓ ✗ ◑ ○, emoji).
//     · Dùng \seqsplit cho dòng dài (tránh Overfull hbox làm compile fail).
//     · Thu hẹp prompt, chỉ đưa field tối thiểu vào longtable.
//     · Escape an toàn hơn trong cell (stripEmoji + textToLatex).
//     · Dùng \raggedright trong cell để text wrap đúng.
//     · Bỏ rowcolor ở header longtable lặp lại (gây lỗi trên 1 số trang).
//   - Giữ nguyên cơ chế fallback HTML print nếu LaTeX service lỗi.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const { textToLatex, textToLatexPlain, textToKatex } = require('./latex-utils');

const router = express.Router();

// ════════════════════════════════════════════════════════════════════
// HTML report route
// ════════════════════════════════════════════════════════════════════
router.get('/:id/html', (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateReportHTML(data));
});

// ════════════════════════════════════════════════════════════════════
// Annotated image routes (canvas-based)
// ════════════════════════════════════════════════════════════════════
router.get('/:id/annotated/:page?', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy' });

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const pageIdx = parseInt(req.params.page || '0');
  const imageFile = data.imageFiles?.[pageIdx];
  if (!imageFile) return res.status(404).json({ error: 'Không tìm thấy ảnh' });

  try {
    const imagePath = path.join(__dirname, '../uploads', imageFile);
    const annotatedPath = path.join(__dirname, '../results', `${req.params.id}_p${pageIdx}_annotated.png`);
    if (!fs.existsSync(annotatedPath)) {
      await createAnnotatedImage(imagePath, data, annotatedPath);
    }
    res.sendFile(path.resolve(annotatedPath));
  } catch (error) {
    console.error('Lỗi tạo ảnh annotated:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/annotated-all', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy' });

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data.imageFiles?.length) return res.status(404).json({ error: 'Không có ảnh' });

  try {
    const allPath = path.join(__dirname, '../results', `${req.params.id}_all_annotated.png`);
    if (!fs.existsSync(allPath)) {
      await createAllAnnotated(data, allPath);
    }
    res.sendFile(path.resolve(allPath));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// Annotated image helpers
// ════════════════════════════════════════════════════════════════════
async function createAnnotatedImage(imagePath, data, outputPath) {
  const img = await loadImage(imagePath);
  const scale = img.width > 1200 ? 1200 / img.width : 1;
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);

  const { gradingResult } = data;
  const allLines = buildAnnotationLines(gradingResult);
  const HEADER_H = 90;
  const FOOTER_H = allLines.length > 0 ? Math.min(allLines.length * 22 + 40, 400) : 0;

  const canvas = createCanvas(W, H + HEADER_H + FOOTER_H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H + HEADER_H + FOOTER_H);

  const { tong_diem, diem_toi_da, phan_tram, xep_loai } = gradingResult;
  const scoreColor = phan_tram >= 80 ? '#1b7a3e' : phan_tram >= 60 ? '#c47f17' : '#c0392b';
  ctx.fillStyle = phan_tram >= 80 ? '#eafaf1' : phan_tram >= 60 ? '#fef9e7' : '#fdedec';
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.strokeStyle = scoreColor;
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, W, HEADER_H);

  ctx.font = 'bold 42px sans-serif';
  ctx.fillStyle = scoreColor;
  ctx.fillText(`${tong_diem}/${diem_toi_da}`, 16, 52);

  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = scoreColor;
  ctx.fillText(`${phan_tram}%  ·  ${xep_loai}`, 16, 78);

  const cac_cau = gradingResult.cac_cau || [];
  let xPos = 200;
  ctx.font = '13px sans-serif';
  for (const cau of cac_cau) {
    const pct = cau.diem_toi_da > 0 ? cau.diem_dat / cau.diem_toi_da : 0;
    const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#c47f17' : '#c0392b';
    ctx.fillStyle = c;
    const label = `${cau.so_cau}: ${cau.diem_dat}/${cau.diem_toi_da}đ`;
    ctx.fillText(label, xPos, 38);
    xPos += ctx.measureText(label).width + 24;
    if (xPos > W - 100) break;
  }

  ctx.drawImage(img, 0, HEADER_H, W, H);

  // Annotation overlay
  if (cac_cau.length > 0) {
    const sectionH = H / cac_cau.length;
    cac_cau.forEach((cau, i) => {
      const y = HEADER_H + i * sectionH;
      const pct = cau.diem_toi_da > 0 ? cau.diem_dat / cau.diem_toi_da : 0;
      const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#e67e22' : '#c0392b';

      if (i > 0) {
        ctx.strokeStyle = 'rgba(180,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const badge = ` ${cau.diem_dat}/${cau.diem_toi_da} `;
      ctx.font = 'bold 15px sans-serif';
      const bw = ctx.measureText(badge).width + 10;
      const bh = 24;
      const bx = W - bw - 8;
      const by = y + 8;

      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(badge, bx + 5, by + 16);

      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = c;
      ctx.fillText(cau.so_cau, 8, y + 22);
    });
  }

  // Footer
  if (allLines.length > 0) {
    const fy = HEADER_H + H;
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, fy, W, FOOTER_H);
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, fy, W, FOOTER_H);

    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#333';
    ctx.fillText('CHI TIẾT CHẤM TỪNG DÒNG', 12, fy + 18);

    ctx.font = '12px monospace';
    let ly = fy + 34;
    for (const line of allLines) {
      if (ly > fy + FOOTER_H - 10) break;

      const isDung = line.ket_qua?.includes('✓');
      const isSai = line.ket_qua?.includes('✗');
      const bgColor = isSai ? '#fff0f0' : isDung ? '#f0fff4' : '#fffbf0';

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, ly - 12, W, 20);

      ctx.fillStyle = '#222';
      const dongText = line.dong?.substring(0, 60) || '';
      ctx.fillText(dongText, 12, ly);

      const kqColor = isSai ? '#c0392b' : isDung ? '#1b7a3e' : '#c47f17';
      ctx.fillStyle = kqColor;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(line.ket_qua || '', W - 100, ly);

      if (line.ghi_chu && isSai) {
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#c0392b';
        const note = '  → ' + line.ghi_chu.substring(0, 80);
        ctx.fillText(note, 12, ly + 14);
        ly += 14;
      }

      ctx.font = '12px monospace';
      ly += 22;
    }
  }

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

async function createAllAnnotated(data, outputPath) {
  const images = [];
  for (const f of data.imageFiles) {
    const p = path.join(__dirname, '../uploads', f);
    if (fs.existsSync(p)) images.push(await loadImage(p));
  }
  if (!images.length) throw new Error('Không có ảnh');

  const maxW = Math.min(Math.max(...images.map(i => i.width)), 1200);
  const totalH = images.reduce((s, i) => s + Math.round(i.height * (maxW / i.width)), 0);
  const HEADER_H = 90;

  const canvas = createCanvas(maxW, totalH + HEADER_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, maxW, totalH + HEADER_H);

  const { tong_diem, diem_toi_da, phan_tram, xep_loai } = data.gradingResult;
  const sc = phan_tram >= 80 ? '#1b7a3e' : phan_tram >= 60 ? '#c47f17' : '#c0392b';
  ctx.fillStyle = phan_tram >= 80 ? '#eafaf1' : phan_tram >= 60 ? '#fef9e7' : '#fdedec';
  ctx.fillRect(0, 0, maxW, HEADER_H);
  ctx.strokeStyle = sc; ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, maxW, HEADER_H);
  ctx.font = 'bold 40px sans-serif'; ctx.fillStyle = sc;
  ctx.fillText(`${tong_diem}/${diem_toi_da}`, 16, 50);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`${phan_tram}%  ·  ${xep_loai}  ·  ${data.studentName}`, 16, 76);

  let yOff = HEADER_H;
  for (const img of images) {
    const scale = maxW / img.width;
    const h = Math.round(img.height * scale);
    ctx.drawImage(img, 0, yOff, maxW, h);
    yOff += h;
  }

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

function htmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mathToHtml(text) {
  if (!text) return '';
  const converted = textToKatex(text);
  return htmlEscape(converted);
}

function buildAnnotationLines(gradingResult) {
  const lines = [];
  if (!gradingResult?.cac_cau) return lines;
  for (const cau of gradingResult.cac_cau) {
    lines.push({
      dong: `── ${cau.so_cau} (${cau.diem_dat}/${cau.diem_toi_da}đ) ──`,
      ket_qua: '', ghi_chu: ''
    });
    if (cau.cham_tung_dong) {
      for (const d of cau.cham_tung_dong) lines.push(d);
    }
  }
  return lines;
}

// ════════════════════════════════════════════════════════════════════
// HTML report
// ════════════════════════════════════════════════════════════════════
function generateReportHTML(data) {
  const { studentName, subject, gradingResult, imageFiles, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, cac_cau } = gradingResult;
  const sc = phan_tram >= 80 ? '#1b7a3e' : phan_tram >= 60 ? '#e67e22' : '#c0392b';

  const cauHTML = (cac_cau || []).map(cau => {
    const pct = cau.diem_toi_da > 0 ? cau.diem_dat / cau.diem_toi_da : 0;
    const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#e67e22' : '#c0392b';

    const dongRows = (cau.cham_tung_dong || []).map(d => {
      const isDung = d.ket_qua?.includes('✓');
      const isSai = d.ket_qua?.includes('✗');
      const bg = isSai ? '#fff5f5' : isDung ? '#f5fff8' : '#ffffff';
      const kqColor = isSai ? '#c0392b' : isDung ? '#1b7a3e' : '#888';
      const dongDisp = d.dong_katex || d.dong || '';
      const ghiChuDisp = d.ghi_chu_katex || d.ghi_chu || '';
      return `<tr style="background:${bg}">
        <td style="font-size:13px;padding:7px 12px;color:#222;line-height:1.6;width:55%">${mathToHtml(dongDisp)}</td>
        <td style="font-weight:700;color:${kqColor};padding:5px 10px;white-space:nowrap;text-align:center;width:8%">${htmlEscape(d.ket_qua || '')}</td>
        <td style="font-size:12px;color:${isSai ? '#c62828' : '#555'};padding:7px 12px;line-height:1.6;width:37%">${mathToHtml(ghiChuDisp)}</td>
      </tr>`;
    }).join('');

    return `<div style="border:1px solid #eee;border-radius:10px;margin-bottom:16px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fafafa;border-bottom:1px solid #eee">
        <span style="font-weight:700;font-size:15px">${htmlEscape(cau.so_cau)}</span>
        <span style="font-size:12px;color:#888">${htmlEscape(cau.trang_thai || '')}</span>
        <span style="font-weight:700;color:${c};font-size:18px;margin-left:auto">${cau.diem_dat}/${cau.diem_toi_da}đ</span>
      </div>
      ${dongRows ? `<table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f5f5f5;font-size:12px;color:#555">
            <th style="text-align:left;padding:6px 12px;border-bottom:1px solid #eee">Bài làm học sinh</th>
            <th style="text-align:center;padding:6px 10px;border-bottom:1px solid #eee">Kết quả</th>
            <th style="text-align:left;padding:6px 12px;border-bottom:1px solid #eee">Nhận xét</th>
          </tr>
        </thead>
        <tbody>${dongRows}</tbody>
      </table>` : '<div style="padding:12px 16px;color:#999;font-size:13px;font-style:italic">(Học sinh không có bước giải nào được ghi nhận)</div>'}
    </div>`;
  }).join('');

  const images = (imageFiles || []).map(f =>
    `<img src="/uploads/${f}" style="max-width:100%;border-radius:8px;border:1px solid #ddd;margin-bottom:10px">`
  ).join('');

  const hallucinationBanner = gradingResult.canh_bao_hallucination?.co_bia_dong
    ? `<div style="background:#fdecea;border-left:4px solid #c0392b;padding:12px 16px;margin-bottom:16px;border-radius:6px;color:#7a1d13;font-size:13px">
         <strong>🚨 Phát hiện AI bịa bước giải:</strong> ${htmlEscape(gradingResult.canh_bao_hallucination.canh_bao_chung)}
       </div>`
    : '';

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Kết quả - ${htmlEscape(studentName)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#f5f5f5;color:#222}
.wrap{max-width:860px;margin:0 auto;padding:24px}.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #eee}
@page{size:A4;margin:14mm}
@media print{
  body{background:#fff}
  .no-print{display:none !important}
  .wrap{max-width:100%;padding:0}
  .card{box-shadow:none;page-break-inside:avoid;border:1px solid #ddd}
  table{page-break-inside:auto}
  tr{page-break-inside:avoid;page-break-after:auto}
  img{max-width:100% !important;page-break-inside:avoid}
  .katex{font-size:1em !important}
}</style></head><body>
<div class="wrap">
  ${hallucinationBanner}
  <div class="card" style="border-left:6px solid ${sc}">
    <div style="font-size:13px;color:#888">${htmlEscape(subject)} · ${new Date(createdAt).toLocaleString('vi-VN')}</div>
    <div style="font-size:22px;font-weight:700;margin:6px 0">${htmlEscape(studentName)}</div>
    <div style="font-size:52px;font-weight:700;color:${sc};line-height:1">${tong_diem}<span style="font-size:24px;color:#aaa">/${diem_toi_da}</span></div>
    <div style="font-size:18px;color:${sc};margin-top:4px">${phan_tram}% · ${htmlEscape(xep_loai)}</div>
  </div>
  <div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:14px">Chấm từng dòng</h2>${cauHTML}</div>
  ${images ? `<div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:12px">Bài làm học sinh</h2>${images}</div>` : ''}
  <div class="no-print" style="text-align:center;margin-top:16px">
    <button onclick="window.print()" style="padding:12px 32px;background:#1a5ca8;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ In / Xuất PDF</button>
  </div>
</div>
<script>
function whenReady(fn) {
  var tries = 0;
  (function check() {
    if (typeof window.renderMathInElement === 'function') return fn();
    if (tries++ > 60) return fn();
    setTimeout(check, 100);
  })();
}
function waitImages() {
  var imgs = Array.from(document.images);
  return Promise.all(imgs.map(function(img) {
    if (img.complete) return Promise.resolve();
    return new Promise(function(res) { img.addEventListener('load', res); img.addEventListener('error', res); });
  }));
}
document.addEventListener("DOMContentLoaded", function() {
  whenReady(function() {
    try {
      window.renderMathInElement(document.body, {
        delimiters: [
          {left:"$$", right:"$$", display:true},
          {left:"$", right:"$", display:false}
        ],
        throwOnError: false,
        strict: false
      });
    } catch(e) { console.warn('KaTeX error:', e); }
    if (new URLSearchParams(location.search).get('print') === '1') {
      waitImages().then(function() {
        setTimeout(function(){ window.print(); }, 300);
      });
    }
  });
});
</script>
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════
// Debug: xem raw LaTeX source
// ════════════════════════════════════════════════════════════════════
router.get('/:id/latex', (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Không tìm thấy bài chấm');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const latex = generateLatex(data);
    const numbered = latex.split('\n').map((l, i) => `${String(i + 1).padStart(4, ' ')}| ${l}`).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(numbered);
  } catch (e) {
    res.status(500).send('Lỗi sinh LaTeX: ' + e.message);
  }
});

// ════════════════════════════════════════════════════════════════════
// PDF export
// Ưu tiên LaTeX (chất lượng cao). Fallback HTML print nếu lỗi.
//   ?via=print  → ép HTML print
//   ?via=latex  → ép LaTeX (hiện lỗi JSON nếu fail — dùng debug)
// ════════════════════════════════════════════════════════════════════
router.get('/:id/pdf', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Không tìm thấy bài chấm');

  const redirectToPrint = (reason) => {
    if (reason) console.warn(`[PDF] → HTML print (${reason})`);
    return res.redirect(`/api/export/${req.params.id}/html?print=1`);
  };

  const forcePrint = req.query.via === 'print';
  const forceLatex = req.query.via === 'latex';
  const latexDisabled = process.env.LATEX_DISABLED === '1';

  if (forcePrint) return redirectToPrint('forced via=print');
  if (latexDisabled && !forceLatex) return redirectToPrint('LATEX_DISABLED');

  const LATEX_URL = process.env.LATEX_SERVICE_URL || 'https://overlef-my-production.up.railway.app/compile';

  let data, latex;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    latex = generateLatex(data);
  } catch (e) {
    console.error('[PDF] Lỗi khi sinh LaTeX source:', e.message);
    if (forceLatex) return res.status(500).json({ error: 'Lỗi sinh LaTeX', detail: e.message });
    return redirectToPrint(`generateLatex: ${e.message}`);
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('content', latex);
    form.append('engine', 'xelatex');

    const r = await fetch(LATEX_URL, {
      method: 'POST',
      headers: form.getHeaders(),
      body: form,
      timeout: 60000
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('═══ LATEX COMPILE ERROR ═══');
      console.error('Student:', data.studentName, '· Result:', req.params.id);
      console.error('Status:', r.status);
      console.error('Error detail:', errText.slice(0, 1500));
      console.error('── LaTeX source (2000 ký tự đầu) ──');
      console.error(latex.slice(0, 2000));
      console.error('═══════════════════════════');
      if (forceLatex) {
        return res.status(500).json({ error: 'LaTeX compile error', detail: errText.slice(0, 1500) });
      }
      return redirectToPrint(`LaTeX service ${r.status}`);
    }

    const pdfBuffer = await r.buffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cham-bai-${req.params.id}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[PDF] Lỗi gọi LaTeX service:', error.message);
    if (forceLatex) return res.status(500).json({ error: 'LaTeX service unreachable', detail: error.message });
    return redirectToPrint(error.message || 'unknown error');
  }
});

// ════════════════════════════════════════════════════════════════════
// LaTeX source generator (FIX lỗi compile)
// ════════════════════════════════════════════════════════════════════

function scoreColor(pct) {
  if (pct >= 80) return 'colorGioi';
  if (pct >= 60) return 'colorKha';
  return 'colorYeu';
}

// Loại bỏ emoji & ký tự đặc biệt gây xung đột font bold XeLaTeX.
// TeX Gyre Termes không có bold glyph cho các emoji → "Missing number" error.
function stripEmojiForLatex(s) {
  return String(s || '')
    .replace(/✓/g, '')
    .replace(/✗/g, '')
    .replace(/◑/g, '')
    .replace(/○/g, '')
    .replace(/✅/g, '')
    .replace(/❌/g, '')
    .replace(/💡/g, '')
    .replace(/⚠️/g, '')
    .replace(/⚠/g, '')
    .replace(/🚨/g, '')
    .replace(/🔴/g, '')
    .replace(/🟢/g, '')
    .replace(/🟡/g, '')
    .replace(/📋/g, '')
    .replace(/📝/g, '')
    .replace(/📄/g, '')
    // Dải emoji/pictograph
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Các glyph dingbat
    .replace(/[\u2713\u2717\u2715\u2716\u2611\u2612]/g, '')
    // Variation selectors
    .replace(/[\uFE00-\uFE0F]/g, '');
}

// Xử lý 1 cell text cho LaTeX: strip emoji → textToLatex → bọc \raggedright.
// \raggedright cần ở đầu cell để text wrap mềm thay vì overfull hbox.
function cellLatex(text) {
  const cleaned = stripEmojiForLatex(text || '');
  const latex = textToLatex(cleaned);
  return latex || '~';
}

function cellPlain(text) {
  const cleaned = stripEmojiForLatex(text || '');
  return textToLatexPlain(cleaned) || '~';
}

function generateLatex(data) {
  const { studentName, subject, gradingResult, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, cac_cau } = gradingResult;
  const date = new Date(createdAt).toLocaleDateString('vi-VN');

  const cauBlocks = (cac_cau || []).map(cau => {
    const diemDatNum = Number(cau.diem_dat || 0);
    const diemMaxNum = Number(cau.diem_toi_da || 0);
    const pct2 = diemMaxNum > 0 ? (diemDatNum / diemMaxNum) * 100 : 0;
    const cc = scoreColor(pct2);

    const trangThai = cau.trang_thai === 'Đúng'
      ? '{\\color{colorGioi}\\textbf{Đúng}}'
      : cau.trang_thai === 'Một phần' || cau.trang_thai === 'Đúng một phần'
        ? '{\\color{colorKha}\\textbf{Một phần}}'
        : cau.trang_thai === 'Bỏ trống'
          ? '{\\color{colorYeu}\\textbf{Bỏ trống}}'
          : '{\\color{colorYeu}\\textbf{Sai}}';

    const chamList = Array.isArray(cau.cham_tung_dong) ? cau.cham_tung_dong : [];
    const dongRows = chamList.map(d => {
      const isDung = d.ket_qua?.includes('✓');
      const isSai = d.ket_qua?.includes('✗');
      const kqColor = isDung ? '\\color{colorGioi}' : isSai ? '\\color{colorYeu}' : '\\color{colorKha}';
      const rowBg = isDung ? '\\rowcolor{bgDung}' : isSai ? '\\rowcolor{bgSai}' : '\\rowcolor{bgChap}';
      const ghiChuLatex = d.ghi_chu ? cellLatex(d.ghi_chu) : '~';
      const dongLatex = cellLatex(d.dong || '');
      const kqLabel = isDung ? 'Đúng' : isSai ? 'Sai' : '---';

      // p{...} column đã cho phép line break; raggedright để tránh overfull
      return `${rowBg}\\raggedright ${dongLatex} & {${kqColor}\\textbf{${kqLabel}}} & \\raggedright ${ghiChuLatex} \\tabularnewline`;
    }).join('\n');

    // Nếu không có dòng nào → skip longtable
    const chamBlock = chamList.length === 0
      ? `\\vspace{2pt}\\noindent{\\small\\itshape\\color{colorKha}(Không có bước giải nào được ghi nhận cho câu này)}`
      : `\\begin{longtable}{|>{\\raggedright\\arraybackslash}p{0.50\\textwidth}|>{\\centering\\arraybackslash}p{0.09\\textwidth}|>{\\raggedright\\arraybackslash}p{0.32\\textwidth}|}
\\hline
\\rowcolor{bgHeader} \\textbf{Bài làm học sinh} & \\textbf{Kết quả} & \\textbf{Nhận xét} \\tabularnewline
\\hline
\\endfirsthead
\\hline
\\rowcolor{bgHeader} \\textbf{Bài làm học sinh} & \\textbf{Kết quả} & \\textbf{Nhận xét} \\tabularnewline
\\hline
\\endhead
${dongRows}
\\hline
\\end{longtable}`;

    return `
\\subsection*{\\color{${cc}}${cellPlain(cau.so_cau || '')} \\hfill ${diemDatNum}/${diemMaxNum}đ \\quad ${trangThai}}
\\vspace{-4pt}
${chamBlock}
\\vspace{4pt}`;
  }).join('\n');

  return `\\documentclass[12pt,a4paper]{article}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setmainlanguage{vietnamese}
\\setmainfont{TeX Gyre Termes}
\\usepackage{geometry}
\\geometry{margin=2cm}
\\usepackage{xcolor}
\\usepackage{colortbl}
\\usepackage{longtable}
\\usepackage{array}
\\usepackage{amsmath,amssymb}
\\usepackage{parskip}
\\usepackage{fancyhdr}

% Cho phép text wrap tốt hơn, giảm overfull hbox
\\tolerance=2000
\\emergencystretch=3em
\\hbadness=10000
\\hfuzz=20pt

% Màu sắc
\\definecolor{colorGioi}{HTML}{1b7a3e}
\\definecolor{colorKha}{HTML}{c47f17}
\\definecolor{colorYeu}{HTML}{c0392b}
\\definecolor{bgHeader}{HTML}{f0f0f0}
\\definecolor{bgDung}{HTML}{f0fff4}
\\definecolor{bgSai}{HTML}{fff5f5}
\\definecolor{bgChap}{HTML}{fffdf0}
\\definecolor{accentBar}{HTML}{${phan_tram >= 80 ? '1b7a3e' : phan_tram >= 60 ? 'c47f17' : 'c0392b'}}

\\pagestyle{fancy}
\\fancyhf{}
\\setlength{\\headheight}{14pt}
\\rhead{\\small ${cellPlain(subject)} · ${cellPlain(date)}}
\\lhead{\\small \\textbf{${cellPlain(studentName)}}}
\\rfoot{\\small Trang \\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}

\\begin{document}

% TRANG BÌA
\\begin{center}
  \\rule{\\textwidth}{2pt}\\\\[6pt]
  {\\Large\\textbf{KẾT QUẢ CHẤM BÀI}}\\\\[4pt]
  {\\large ${cellPlain(subject)}}\\\\[2pt]
  {\\small ${cellPlain(date)}}\\\\[8pt]
  \\rule{\\textwidth}{0.5pt}\\\\[8pt]
  {\\LARGE\\textbf{${cellPlain(studentName)}}}\\\\[12pt]
  {\\fontsize{56}{60}\\selectfont\\color{accentBar}\\textbf{${tong_diem}}}%
  {\\Large\\color{gray}/${diem_toi_da}}\\\\[4pt]
  {\\large\\color{accentBar}\\textbf{${phan_tram}\\% -- ${cellPlain(xep_loai)}}}\\\\[10pt]
  \\rule{\\textwidth}{0.5pt}
\\end{center}

\\vspace{12pt}

\\section*{Chi tiết chấm từng dòng}

${cauBlocks}

\\end{document}`;
}

module.exports = router;

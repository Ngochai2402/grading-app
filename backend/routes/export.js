const express = require('express');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

// ═══ FIX PDF LATEX COMPILE ERROR ═══
// Thay thế escLat và unicodeToLatex cũ bằng module latex-utils mới
// Module này xử lý đúng:
//   - \frac, \sqrt, \Delta và các LaTeX command Claude sinh ra
//   - Δ, x², x₁, √21 và các ký tự Unicode
//   - Sanitize lệnh sai (\bet → \beta, \mathttt → \mathtt)
//   - Escape an toàn ký tự đặc biệt LaTeX
const { textToLatex, textToLatexPlain, textToKatex } = require('./latex-utils');

const router = express.Router();

// GET /api/export/:id/html — báo cáo HTML
router.get('/:id/html', (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateReportHTML(data));
});

// GET /api/export/:id/annotated — ảnh có annotation bút đỏ
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

// GET /api/export/:id/annotated-all — tất cả trang gộp thành 1 ảnh dài
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

// ─── Vẽ annotation lên ảnh ────────────────────────────────────────────────────
async function createAnnotatedImage(imagePath, data, outputPath) {
  const img = await loadImage(imagePath);
  const scale = img.width > 1200 ? 1200 / img.width : 1;
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);

  const { gradingResult, transcribed } = data;
  const allLines = buildAnnotationLines(gradingResult, transcribed);
  const HEADER_H = 90;
  const FOOTER_H = allLines.length > 0 ? Math.min(allLines.length * 22 + 40, 400) : 0;

  const canvas = createCanvas(W, H + HEADER_H + FOOTER_H);
  const ctx = canvas.getContext('2d');

  // Nền trắng
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H + HEADER_H + FOOTER_H);

  // ── HEADER: tóm tắt điểm ──
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
    const pct = cau.diem_dat / cau.diem_toi_da;
    const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#c47f17' : '#c0392b';
    ctx.fillStyle = c;
    const label = `${cau.so_cau}: ${cau.diem_dat}/${cau.diem_toi_da}đ`;
    ctx.fillText(label, xPos, 38);
    xPos += ctx.measureText(label).width + 24;
    if (xPos > W - 100) break;
  }

  // ── ẢNH GỐC ──
  ctx.drawImage(img, 0, HEADER_H, W, H);

  // ── ANNOTATION TRÊN ẢNH ──
  if (cac_cau.length > 0) {
    const sectionH = H / cac_cau.length;
    cac_cau.forEach((cau, i) => {
      const y = HEADER_H + i * sectionH;
      const pct = cau.diem_dat / cau.diem_toi_da;
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

  // ── FOOTER: chấm từng dòng ──
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

// Escape HTML đơn giản — không đụng $, \, { vì KaTeX auto-render cần giữ nguyên
function htmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Render text thành HTML an toàn cho KaTeX: wrap math bằng $...$, escape HTML.
// Ưu tiên text đã được preprocess (có $...$); nếu chưa, tự tokenize qua textToKatex.
function mathToHtml(text) {
  if (!text) return '';
  const converted = textToKatex(text);
  return htmlEscape(converted);
}

function buildAnnotationLines(gradingResult, transcribed) {
  const lines = [];
  if (!gradingResult?.cac_cau) return lines;
  for (const cau of gradingResult.cac_cau) {
    lines.push({ dong: `── ${cau.so_cau} (${cau.diem_dat}/${cau.diem_toi_da}đ) ──`, ket_qua: '', ghi_chu: '' });
    if (cau.cham_tung_dong) {
      for (const d of cau.cham_tung_dong) lines.push(d);
    }
  }
  return lines;
}

// ─── HTML report (giữ nguyên hàm cũ) ──────────────────────────────────────────
function generateReportHTML(data) {
  const { studentName, subject, gradingResult, imageFiles, transcribed, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;
  const sc = phan_tram >= 80 ? '#1b7a3e' : phan_tram >= 60 ? '#e67e22' : '#c0392b';

  const cauHTML = (cac_cau || []).map(cau => {
    const pct = cau.diem_dat / cau.diem_toi_da;
    const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#e67e22' : '#c0392b';

    const dongRows = (cau.cham_tung_dong || []).map(d => {
      const isDung = d.ket_qua?.includes('✓');
      const isSai = d.ket_qua?.includes('✗');
      const bg = isSai ? '#fff5f5' : isDung ? '#f5fff8' : '#fffdf0';
      const kqColor = isSai ? '#c0392b' : isDung ? '#1b7a3e' : '#c47f17';
      const canhBao = d.canh_bao ? `<div style="background:#fff3cd;border-left:3px solid #f0ad4e;padding:4px 8px;margin-top:4px;font-size:11px;color:#856404">⚠️ ${htmlEscape(d.canh_bao)}</div>` : '';
      const dongDisp = d.dong_katex || d.dong || '';
      const ghiChuDisp = d.ghi_chu_katex || d.ghi_chu || '';
      return `<tr style="background:${bg}">
        <td style="font-size:13px;padding:7px 12px;color:#222;line-height:1.6">${mathToHtml(dongDisp)}${canhBao}</td>
        <td style="font-weight:700;color:${kqColor};padding:5px 10px;white-space:nowrap">${htmlEscape(d.ket_qua || '')}</td>
        <td style="font-size:12px;color:${isSai?'#c62828':'#555'};padding:7px 12px;line-height:1.6">${mathToHtml(ghiChuDisp)}</td>
      </tr>`;
    }).join('');

    const loiSaiDisp = cau.loi_sai_katex || cau.loi_sai || '';
    return `<div style="border:1px solid #eee;border-radius:10px;margin-bottom:16px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fafafa;border-bottom:1px solid #eee">
        <span style="font-weight:700;font-size:15px">${htmlEscape(cau.so_cau)}</span>
        <span style="font-weight:700;color:${c};font-size:18px;margin-left:auto">${cau.diem_dat}/${cau.diem_toi_da}đ</span>
      </div>
      ${dongRows ? `<table style="width:100%;border-collapse:collapse">${dongRows}</table>` : ''}
      ${loiSaiDisp ? `<div style="padding:10px 16px;background:#fff5f5;color:#c0392b;font-size:13px">✗ ${mathToHtml(loiSaiDisp)}</div>` : ''}
    </div>`;
  }).join('');

  const images = (imageFiles || []).map((f, i) =>
    `<img src="/uploads/${f}" style="max-width:100%;border-radius:8px;border:1px solid #ddd;margin-bottom:10px">`
  ).join('');

  // Cảnh báo integrity nếu có
  const integrityBanner = gradingResult.kiem_tra_toan_ven?.co_vi_pham
    ? `<div style="background:#fff3cd;border-left:4px solid #f0ad4e;padding:12px 16px;margin-bottom:16px;border-radius:6px;color:#856404;font-size:13px">
         <strong>⚠️ Lưu ý:</strong> ${htmlEscape(gradingResult.kiem_tra_toan_ven.canh_bao_chung)}
       </div>`
    : '';

  // Cảnh báo Claude bịa dòng — quan trọng để giáo viên biết AI đã chèn bước giả
  const hallucinationBanner = gradingResult.canh_bao_hallucination?.co_bia_dong
    ? `<div style="background:#fdecea;border-left:4px solid #c0392b;padding:12px 16px;margin-bottom:16px;border-radius:6px;color:#7a1d13;font-size:13px">
         <strong>🚨 Phát hiện AI bịa bước giải:</strong> ${htmlEscape(gradingResult.canh_bao_hallucination.canh_bao_chung)}
         <details style="margin-top:6px"><summary style="cursor:pointer">Xem chi tiết</summary>
         <ul style="margin:6px 0 0 16px">
         ${gradingResult.canh_bao_hallucination.chi_tiet.map(c =>
           `<li><strong>${htmlEscape(c.so_cau)}:</strong> ${c.dong_bi_drop.map(d =>
             `<code style="background:#fff;padding:1px 4px;border-radius:3px">${htmlEscape(d.dong_claude_bia)}</code>`
           ).join(', ')}</li>`
         ).join('')}
         </ul></details>
       </div>`
    : '';

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Kết quả - ${studentName}</title>
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
  ${integrityBanner}
  <div class="card" style="border-left:6px solid ${sc}">
    <div style="font-size:13px;color:#888">${subject} · ${new Date(createdAt).toLocaleString('vi-VN')}</div>
    <div style="font-size:22px;font-weight:700;margin:6px 0">${studentName}</div>
    <div style="font-size:52px;font-weight:700;color:${sc};line-height:1">${tong_diem}<span style="font-size:24px;color:#aaa">/${diem_toi_da}</span></div>
    <div style="font-size:18px;color:${sc};margin-top:4px">${phan_tram}% · ${xep_loai}</div>
    ${nhan_xet_chung ? `<div style="margin-top:12px;padding:12px;background:#f8f8f8;border-radius:8px;font-size:14px;line-height:1.6">${mathToHtml(gradingResult.nhan_xet_chung_katex || nhan_xet_chung)}</div>` : ''}
  </div>
  <div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:14px">Chấm từng dòng</h2>${cauHTML}</div>
  ${images ? `<div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:12px">Bài làm học sinh</h2>${images}</div>` : ''}
  <div class="no-print" style="text-align:center;margin-top:16px">
    <button onclick="window.print()" style="padding:12px 32px;background:#1a5ca8;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ In / Xuất PDF</button>
  </div>
</div>
<script>
// Chờ KaTeX load + ảnh tải xong rồi mới render + in → PDF sắc nét, không cắt math
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
          {left:"$", right:"$", display:false},
          {left:"\\\\(", right:"\\\\)", display:false},
          {left:"\\\\[", right:"\\\\]", display:true}
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

// ─── PDF export: mặc định dùng HTML auto-print (không phụ thuộc service ngoài)
// ─────────────────────────────────────────────────────────────────────────────
// LaTeX external service (Railway xelatex) rất dễ lỗi compile với font/math
// phức tạp + tiếng Việt → mặc định TẮT. Người dùng luôn xuất được PDF qua
// trình duyệt (Save as PDF từ hộp thoại in).
//
// Bật lại LaTeX: set LATEX_ENABLED=1 và LATEX_SERVICE_URL=<url>.
// Khi LaTeX lỗi bất kỳ (network / compile / timeout) → auto fallback HTML print.
// KHÔNG BAO GIỜ trả JSON error từ endpoint này.
router.get('/:id/pdf', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Không tìm thấy bài chấm');
  }

  const redirectToPrint = (reason) => {
    if (reason) console.warn(`[PDF] → HTML print (${reason})`);
    return res.redirect(`/api/export/${req.params.id}/html?print=1`);
  };

  // Default: HTML print. Chỉ thử LaTeX khi opt-in rõ ràng.
  const latexEnabled = process.env.LATEX_ENABLED === '1' && process.env.LATEX_SERVICE_URL;
  const forceLatex = req.query.via === 'latex';
  const forcePrint = req.query.via === 'print';

  if (forcePrint) return redirectToPrint('forced via=print');
  if (!latexEnabled && !forceLatex) return redirectToPrint('default HTML print mode');

  // Nhánh LaTeX (opt-in): vẫn bọc try/catch toàn phần, bao giờ lỗi → fallback
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const latex = generateLatex(data);
    const LATEX_URL = process.env.LATEX_SERVICE_URL;

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
      console.error('[PDF/LaTeX]', r.status, errText.slice(0, 300));
      return redirectToPrint(`LaTeX service ${r.status}`);
    }

    const pdfBuffer = await r.buffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cham-bai-${req.params.id}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    return redirectToPrint(error.message || 'unknown error');
  }
});

function scoreColor(pct) {
  if (pct >= 80) return 'colorGioi';
  if (pct >= 60) return 'colorKha';
  return 'colorYeu';
}

// ─── Sinh LaTeX source với hàm textToLatex MỚI (an toàn) ─────────────────────
function generateLatex(data) {
  const { studentName, subject, gradingResult, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;
  const date = new Date(createdAt).toLocaleDateString('vi-VN');

  const cauBlocks = (cac_cau || []).map(cau => {
    const pct2 = (cau.diem_dat / cau.diem_toi_da) * 100;
    const cc = scoreColor(pct2);
    const trangThai = cau.trang_thai === 'Đúng' ? '{\\color{colorGioi}\\textbf{✓ Đúng}}' :
                      cau.trang_thai === 'Một phần' || cau.trang_thai === 'Đúng một phần' ? '{\\color{colorKha}\\textbf{◑ Một phần}}' :
                      cau.trang_thai === 'Bỏ trống' ? '{\\color{colorYeu}\\textbf{○ Bỏ trống}}' :
                      '{\\color{colorYeu}\\textbf{✗ Sai}}';

    const dongRows = (cau.cham_tung_dong || []).map(d => {
      const isDung = d.ket_qua?.includes('✓');
      const isSai  = d.ket_qua?.includes('✗');
      const kqColor = isDung ? '\\color{colorGioi}' : isSai ? '\\color{colorYeu}' : '\\color{colorKha}';
      const rowBg = isDung ? '\\rowcolor{bgDung}' : isSai ? '\\rowcolor{bgSai}' : '\\rowcolor{bgChap}';
      const ghiChu = d.ghi_chu ? `\\footnotesize{${textToLatex(d.ghi_chu)}}` : '';
      // Cảnh báo nếu dòng bị AI sửa và đã khôi phục
      const canhBaoLine = d.canh_bao ? ` {\\tiny\\color{colorKha}(${textToLatexPlain(d.canh_bao)})}` : '';
      return `${rowBg} ${textToLatex(d.dong || '')}${canhBaoLine} & {${kqColor}\\textbf{${textToLatexPlain(d.ket_qua || '')}}} & ${ghiChu} \\\\`;
    }).join('\n');

    const loiSai = cau.loi_sai ? `\\vspace{2pt}\\noindent{\\color{colorYeu}\\small ✗ \\textbf{Lỗi:} ${textToLatex(cau.loi_sai)}}` : '';
    const goiY   = cau.goi_y_sua ? `\\vspace{2pt}\\noindent{\\color{colorBlue}\\small 💡 ${textToLatex(cau.goi_y_sua)}}` : '';

    return `
\\subsection*{\\color{${cc}}${textToLatexPlain(cau.so_cau)} \\hfill ${cau.diem_dat}/${cau.diem_toi_da}đ \\quad ${trangThai}}
\\vspace{-4pt}
\\begin{longtable}{p{0.42\\textwidth} p{0.13\\textwidth} p{0.38\\textwidth}}
\\hline
\\rowcolor{bgHeader} \\textbf{Bài làm học sinh} & \\textbf{Kết quả} & \\textbf{Nhận xét} \\\\
\\hline
${dongRows}
\\hline
\\end{longtable}
${loiSai}
\\vspace{4pt}`;
  }).join('\n');

  // Banner cảnh báo integrity (nếu có AI sửa bài)
  const integrityWarning = gradingResult.kiem_tra_toan_ven?.co_vi_pham
    ? `\\vspace{6pt}
\\noindent\\colorbox{bgWarn}{\\parbox{\\dimexpr\\textwidth-2\\fboxsep}{\\small \\textbf{⚠️ Lưu ý:} ${textToLatexPlain(gradingResult.kiem_tra_toan_ven.canh_bao_chung)}}}
\\vspace{6pt}`
    : '';

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
\\usepackage{booktabs}
\\usepackage{amsmath,amssymb}
\\usepackage{array}
\\usepackage{parskip}
\\usepackage{titlesec}
\\usepackage{fancyhdr}
\\usepackage{graphicx}

% Màu sắc
\\definecolor{colorGioi}{HTML}{1b7a3e}
\\definecolor{colorKha}{HTML}{c47f17}
\\definecolor{colorYeu}{HTML}{c0392b}
\\definecolor{colorBlue}{HTML}{1565c0}
\\definecolor{bgHeader}{HTML}{f0f0f0}
\\definecolor{bgDung}{HTML}{f0fff4}
\\definecolor{bgSai}{HTML}{fff5f5}
\\definecolor{bgChap}{HTML}{fffdf0}
\\definecolor{bgWarn}{HTML}{fff3cd}
\\definecolor{accentBar}{HTML}{${phan_tram >= 80 ? '1b7a3e' : phan_tram >= 60 ? 'c47f17' : 'c0392b'}}

\\pagestyle{fancy}
\\fancyhf{}
\\rhead{\\small ${textToLatexPlain(subject)} · ${textToLatexPlain(date)}}
\\lhead{\\small \\textbf{${textToLatexPlain(studentName)}}}
\\rfoot{\\small Trang \\thepage}

\\begin{document}

% ── TRANG BÌA ─────────────────────────────────────────────────────────────────
\\begin{center}
  \\rule{\\textwidth}{2pt}\\\\[6pt]
  {\\Large\\textbf{KẾT QUẢ CHẤM BÀI}}\\\\[4pt]
  {\\large ${textToLatexPlain(subject)}}\\\\[2pt]
  {\\small ${textToLatexPlain(date)}}\\\\[8pt]
  \\rule{\\textwidth}{0.5pt}\\\\[8pt]
  {\\LARGE\\textbf{${textToLatexPlain(studentName)}}}\\\\[12pt]
  {\\fontsize{56}{60}\\selectfont\\color{accentBar}\\textbf{${tong_diem}}}%
  {\\Large\\color{gray}/${diem_toi_da}}\\\\[4pt]
  {\\large\\color{accentBar}\\textbf{${phan_tram}\\% · ${textToLatexPlain(xep_loai)}}}\\\\[10pt]
  \\rule{\\textwidth}{0.5pt}
\\end{center}

${integrityWarning}

\\vspace{8pt}
\\noindent\\colorbox{bgHeader}{\\parbox{\\dimexpr\\textwidth-2\\fboxsep}{\\small ${textToLatex(nhan_xet_chung || '')}}}
\\vspace{12pt}

% ── CHI TIẾT ──────────────────────────────────────────────────────────────────
\\section*{Chi tiết chấm từng dòng}

${cauBlocks}

\\end{document}`;
}

module.exports = router;

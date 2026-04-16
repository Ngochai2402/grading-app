const express = require('express');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

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

  // Tính số dòng annotation cần thiết
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

  // Điểm lớn
  ctx.font = 'bold 42px sans-serif';
  ctx.fillStyle = scoreColor;
  ctx.fillText(`${tong_diem}/${diem_toi_da}`, 16, 52);

  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = scoreColor;
  ctx.fillText(`${phan_tram}%  ·  ${xep_loai}`, 16, 78);

  // Điểm từng câu ở header
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

  // ── ANNOTATION TRÊN ẢNH: gạch dưới từng câu + ghi điểm bên phải ──
  if (cac_cau.length > 0) {
    const sectionH = H / cac_cau.length;
    cac_cau.forEach((cau, i) => {
      const y = HEADER_H + i * sectionH;
      const pct = cau.diem_dat / cau.diem_toi_da;
      const c = pct >= 0.8 ? '#1b7a3e' : pct >= 0.4 ? '#e67e22' : '#c0392b';

      // Đường kẻ phân cách câu (trừ câu đầu)
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

      // Badge điểm bên phải
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

      // Tên câu
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

      // Màu theo kết quả
      const isDung = line.ket_qua?.includes('✓');
      const isSai = line.ket_qua?.includes('✗');
      const bgColor = isSai ? '#fff0f0' : isDung ? '#f0fff4' : '#fffbf0';

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, ly - 12, W, 20);

      // Nội dung dòng
      ctx.fillStyle = '#222';
      const dongText = line.dong?.substring(0, 60) || '';
      ctx.fillText(dongText, 12, ly);

      // Kết quả
      const kqColor = isSai ? '#c0392b' : isDung ? '#1b7a3e' : '#c47f17';
      ctx.fillStyle = kqColor;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(line.ket_qua || '', W - 100, ly);

      // Ghi chú nếu có
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
  // Gộp tất cả ảnh thành 1 file dài
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

  // Header
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

function mathToLatex(text) {
  if (!text) return '';
  return text
    .replace(/x₁x₂/g, '\\(x_1 x_2\\)').replace(/x₁/g, '\\(x_1\\)').replace(/x₂/g, '\\(x_2\\)')
    .replace(/x₃/g, '\\(x_3\\)').replace(/x₄/g, '\\(x_4\\)')
    .replace(/\(([^)]+)\)²/g, (m,p1) => `\\((${p1})^2\\)`)
    .replace(/([A-Za-z0-9])²/g, '\\($1^2\\)')
    .replace(/([A-Za-z0-9])³/g, '\\($1^3\\)')
    .replace(/√(\d+)/g, '\\(\\sqrt{$1}\\)')
    .replace(/(\d+)\/(\d+)/g, '\\(\\dfrac{$1}{$2}\\)')
    .replace(/[Δ△]/g, '\\(\\Delta\\)')
    .replace(/≈/g, '\\(\\approx\\)').replace(/≤/g, '\\(\\leq\\)').replace(/≥/g, '\\(\\geq\\)')
    .replace(/⟹/g, '\\(\\Rightarrow\\)').replace(/→/g, '\\(\\to\\)');
}

function mathToHtml(text) {
  if (!text) return '';
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  let result = '';
  let i = 0;
  const tryKatex = (latex) => {
    try { return `<span class="math">${latex}</span>`; }
    catch { return latex; }
  };
  while (i < text.length) {
    const ch = text[i];
    const fracM = text.slice(i).match(/^(\d+)\/(\d+)/);
    if (fracM) { result += tryKatex(`\\(\\dfrac{${fracM[1]}}{${fracM[2]}}\\)`); i += fracM[0].length; continue; }
    if (/[a-zA-Z]/.test(ch) && i+1 < text.length && SUB.includes(text[i+1])) {
      const sub = SUB.indexOf(text[i+1]);
      result += tryKatex(`\\(${ch}_{${sub}}\\)`); i += 2; continue;
    }
    if (ch === '²') { result += tryKatex('\\(^2\\)'); i++; continue; }
    if (ch === '³') { result += tryKatex('\\(^3\\)'); i++; continue; }
    if (ch === '√') {
      let num='', j=i+1;
      while(j<text.length && /\d/.test(text[j])){num+=text[j];j++;}
      result += tryKatex(`\\(\\sqrt{${num||''}}\\)`); i=j; continue;
    }
    const syms = {'Δ':'\\Delta','△':'\\Delta','≈':'\\approx','≤':'\\leq','≥':'\\geq','⟹':'\\Rightarrow','→':'\\to','≠':'\\neq','∈':'\\in'};
    if (syms[ch]) { result += tryKatex(`\\(${syms[ch]}\\)`); i++; continue; }
    result += ch.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    i++;
  }
  return result;
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
      return `<tr style="background:${bg}">
        <td style="font-size:13px;padding:7px 12px;color:#222;line-height:1.6">${mathToHtml(d.dong || '')}</td>
        <td style="font-weight:700;color:${kqColor};padding:5px 10px;white-space:nowrap">${d.ket_qua || ''}</td>
        <td style="font-size:12px;color:${isSai?'#c62828':'#555'};padding:7px 12px;line-height:1.6">${mathToHtml(d.ghi_chu || '')}</td>
      </tr>`;
    }).join('');

    return `<div style="border:1px solid #eee;border-radius:10px;margin-bottom:16px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fafafa;border-bottom:1px solid #eee">
        <span style="font-weight:700;font-size:15px">${cau.so_cau}</span>
        <span style="font-weight:700;color:${c};font-size:18px;margin-left:auto">${cau.diem_dat}/${cau.diem_toi_da}đ</span>
      </div>
      ${dongRows ? `<table style="width:100%;border-collapse:collapse">${dongRows}</table>` : ''}
      ${cau.loi_sai ? `<div style="padding:10px 16px;background:#fff5f5;color:#c0392b;font-size:13px">✗ ${cau.loi_sai}</div>` : ''}
      ${cau.goi_y_sua ? `<div style="padding:10px 16px;background:#f0f7ff;color:#1a5ca8;font-size:13px">💡 ${cau.goi_y_sua}</div>` : ''}
    </div>`;
  }).join('');

  const images = (imageFiles || []).map((f, i) =>
    `<img src="/uploads/${f}" style="max-width:100%;border-radius:8px;border:1px solid #ddd;margin-bottom:10px">`
  ).join('');

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Kết quả - ${studentName}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#f5f5f5;color:#222}
.wrap{max-width:860px;margin:0 auto;padding:24px}.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #eee}
@media print{body{background:#fff}.no-print{display:none}}</style></head><body>
<div class="wrap">
  <div class="card" style="border-left:6px solid ${sc}">
    <div style="font-size:13px;color:#888">${subject} · ${new Date(createdAt).toLocaleString('vi-VN')}</div>
    <div style="font-size:22px;font-weight:700;margin:6px 0">${studentName}</div>
    <div style="font-size:52px;font-weight:700;color:${sc};line-height:1">${tong_diem}<span style="font-size:24px;color:#aaa">/${diem_toi_da}</span></div>
    <div style="font-size:18px;color:${sc};margin-top:4px">${phan_tram}% · ${xep_loai}</div>
    ${nhan_xet_chung ? `<div style="margin-top:12px;padding:12px;background:#f8f8f8;border-radius:8px;font-size:14px;line-height:1.6">${nhan_xet_chung}</div>` : ''}
  </div>
  <div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:14px">Chấm từng dòng</h2>${cauHTML}</div>
  ${images ? `<div class="card"><h2 style="font-size:16px;font-weight:600;margin-bottom:12px">Bài làm học sinh</h2>${images}</div>` : ''}
  <div class="no-print" style="text-align:center;margin-top:16px">
    <button onclick="window.print()" style="padding:12px 32px;background:#1a5ca8;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ In / Xuất PDF</button>
  </div>
</div>
<script>
document.addEventListener("DOMContentLoaded", function() {
  renderMathInElement(document.body, {
    delimiters: [
      {left:"\\(", right:"\\)", display:false},
      {left:"\\[", right:"\\]", display:true}
    ],
    throwOnError: false
  });
});
</script>
</body></html>`;
}

// GET /api/export/:id/pdf — xuất PDF đẹp qua LaTeX service
router.get('/:id/pdf', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy' });

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const latex = generateLatex(data);

  try {
    const LATEX_URL = process.env.LATEX_SERVICE_URL || 'https://overlef-my-production.up.railway.app/compile';
    const fetch = (await import('node-fetch')).default;

    // Gửi dạng multipart/form-data như browser form submit
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
      return res.status(500).json({ error: 'LaTeX compile error', detail: errText.slice(0, 500) });
    }

    const pdfBuffer = await r.buffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cham-bai-${req.params.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Lỗi xuất PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

function escLat(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}');
}

function unicodeToLatex(s) {
  if (!s) return '';
  const parts = [];
  const re = /\$([^$\n]+?)\$/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(escLat(s.slice(last, m.index)));
    parts.push('$' + m[1] + '$');
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(escLat(s.slice(last)));
  return parts.join('');
}

function scoreColor(pct) {
  if (pct >= 80) return 'colorGioi';
  if (pct >= 60) return 'colorKha';
  return 'colorYeu';
}

function generateLatex(data) {
  const { studentName, subject, gradingResult, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;
  const date = new Date(createdAt).toLocaleDateString('vi-VN');
  const sc = scoreColor(phan_tram);

  const cauBlocks = (cac_cau || []).map(cau => {
    const pct2 = (cau.diem_dat / cau.diem_toi_da) * 100;
    const cc = scoreColor(pct2);
    const trangThai = cau.trang_thai === 'Đúng' ? '{\\color{colorGioi}\\textbf{✓ Đúng}}' :
                      cau.trang_thai === 'Một phần' ? '{\\color{colorKha}\\textbf{◑ Một phần}}' :
                      '{\\color{colorYeu}\\textbf{✗ Sai}}';

    const dongRows = (cau.cham_tung_dong || []).map(d => {
      const isDung = d.ket_qua?.includes('✓');
      const isSai  = d.ket_qua?.includes('✗');
      const kqColor = isDung ? '\\color{colorGioi}' : isSai ? '\\color{colorYeu}' : '\\color{colorKha}';
      const rowBg = isDung ? '\\rowcolor{bgDung}' : isSai ? '\\rowcolor{bgSai}' : '\\rowcolor{bgChap}';
      const ghiChu = d.ghi_chu ? `\\footnotesize{${unicodeToLatex(d.ghi_chu)}}` : '';
      return `${rowBg} ${unicodeToLatex(d.dong || '')} & {${kqColor}\\textbf{${escLat(d.ket_qua || '')}}} & ${ghiChu} \\\\`;
    }).join('\n');

    const loiSai = cau.loi_sai ? `\\vspace{2pt}\\noindent{\\color{colorYeu}\\small ✗ \\textbf{Lỗi:} ${unicodeToLatex(cau.loi_sai)}}` : '';
    const goiY   = cau.goi_y_sua ? `\\vspace{2pt}\\noindent{\\color{colorBlue}\\small 💡 ${unicodeToLatex(cau.goi_y_sua)}}` : '';

    return `
\\subsection*{\\color{${cc}}${escLat(cau.so_cau)} \\hfill ${cau.diem_dat}/${cau.diem_toi_da}đ \\quad ${trangThai}}
\\vspace{-4pt}
\\begin{longtable}{p{0.42\\textwidth} p{0.13\\textwidth} p{0.38\\textwidth}}
\\hline
\\rowcolor{bgHeader} \\textbf{Bài làm học sinh} & \\textbf{Kết quả} & \\textbf{Nhận xét} \\\\
\\hline
${dongRows}
\\hline
\\end{longtable}
${loiSai}
${goiY}
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
\\definecolor{accentBar}{HTML}{${phan_tram >= 80 ? '1b7a3e' : phan_tram >= 60 ? 'c47f17' : 'c0392b'}}

\\pagestyle{fancy}
\\fancyhf{}
\\rhead{\\small ${escLat(subject)} · ${escLat(date)}}
\\lhead{\\small \\textbf{${escLat(studentName)}}}
\\rfoot{\\small Trang \\thepage}

\\begin{document}

% ── TRANG BÌA ─────────────────────────────────────────────────────────────────
\\begin{center}
  \\rule{\\textwidth}{2pt}\\\\[6pt]
  {\\Large\\textbf{KẾT QUẢ CHẤM BÀI}}\\\\[4pt]
  {\\large ${escLat(subject)}}\\\\[2pt]
  {\\small ${escLat(date)}}\\\\[8pt]
  \\rule{\\textwidth}{0.5pt}\\\\[8pt]
  {\\LARGE\\textbf{${escLat(studentName)}}}\\\\[12pt]
  {\\fontsize{56}{60}\\selectfont\\color{accentBar}\\textbf{${tong_diem}}}%
  {\\Large\\color{gray}/${diem_toi_da}}\\\\[4pt]
  {\\large\\color{accentBar}\\textbf{${phan_tram}\\% · ${escLat(xep_loai)}}}\\\\[10pt]
  \\rule{\\textwidth}{0.5pt}
\\end{center}

\\vspace{8pt}
\\noindent\\colorbox{bgHeader}{\\parbox{\\dimexpr\\textwidth-2\\fboxsep}{\\small ${unicodeToLatex(nhan_xet_chung)}}}
\\vspace{12pt}

% ── CHI TIẾT ──────────────────────────────────────────────────────────────────
\\section*{Chi tiết chấm từng dòng}

${cauBlocks}

\\end{document}`;
}


module.exports = router;

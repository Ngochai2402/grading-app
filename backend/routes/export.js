const express = require('express');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

const router = express.Router();

// GET /api/export/:id/pdf — xuất báo cáo HTML (in từ browser)
router.get('/:id/html', (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Không tìm thấy kết quả' });
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const html = generateReportHTML(data);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /api/export/:id/annotated — ảnh bài làm có chú thích điểm
router.get('/:id/annotated', async (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Không tìm thấy kết quả' });
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  try {
    // Tạo ảnh annotated cho ảnh đầu tiên
    const imageFile = data.imageFiles[0];
    const imagePath = path.join(__dirname, '../uploads', imageFile);
    const annotatedPath = path.join(__dirname, '../results', `${req.params.id}_annotated.png`);

    if (!fs.existsSync(annotatedPath)) {
      await createAnnotatedImage(imagePath, data.gradingResult, annotatedPath);
    }

    res.sendFile(annotatedPath);
  } catch (error) {
    console.error('Lỗi tạo ảnh annotated:', error);
    res.status(500).json({ error: error.message });
  }
});

async function createAnnotatedImage(imagePath, gradingResult, outputPath) {
  const img = await loadImage(imagePath);

  // Scale ảnh nếu quá lớn
  const maxWidth = 1200;
  const scale = img.width > maxWidth ? maxWidth / img.width : 1;
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale) + 220; // thêm phần header

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Nền trắng
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Vẽ ảnh gốc
  ctx.drawImage(img, 0, 220, width, Math.round(img.height * scale));

  // Header chứa tóm tắt điểm
  drawScoreSummary(ctx, gradingResult, width);

  // Lưu file
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
}

function drawScoreSummary(ctx, result, width) {
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = result;

  // Nền header
  const color = phan_tram >= 80 ? '#e8f5e9' : phan_tram >= 60 ? '#fff8e1' : '#ffebee';
  const borderColor = phan_tram >= 80 ? '#4caf50' : phan_tram >= 60 ? '#ff9800' : '#f44336';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, 210);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, width, 210);

  // Điểm tổng
  ctx.font = 'bold 48px sans-serif';
  ctx.fillStyle = borderColor;
  ctx.textAlign = 'left';
  ctx.fillText(`${tong_diem}/${diem_toi_da}`, 20, 60);

  ctx.font = '22px sans-serif';
  ctx.fillStyle = '#333';
  ctx.fillText(`${phan_tram}%  •  ${xep_loai}`, 20, 92);

  // Nhận xét chung
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#555';
  const words = (nhan_xet_chung || '').split(' ');
  let line = '';
  let y = 120;
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > width - 40 && line) {
      ctx.fillText(line, 20, y);
      line = word + ' ';
      y += 22;
      if (y > 165) { ctx.fillText('...', 20, y); break; }
    } else {
      line = test;
    }
  }
  if (y <= 165) ctx.fillText(line, 20, y);

  // Điểm từng câu
  if (cac_cau && cac_cau.length > 0) {
    ctx.font = 'bold 13px sans-serif';
    let x = 20;
    const y2 = 195;
    for (const cau of cac_cau) {
      const isCorrect = cau.trang_thai === 'Đúng';
      const isPartial = cau.trang_thai === 'Một phần';
      ctx.fillStyle = isCorrect ? '#4caf50' : isPartial ? '#ff9800' : '#f44336';
      const label = `${cau.so_cau}: ${cau.diem_dat}/${cau.diem_toi_da}`;
      ctx.fillText(label, x, y2);
      x += ctx.measureText(label).width + 20;
      if (x > width - 100) break;
    }
  }
}

function generateReportHTML(data) {
  const { studentName, subject, gradingResult, imageFiles, createdAt } = data;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;

  const scoreColor = phan_tram >= 80 ? '#2e7d32' : phan_tram >= 60 ? '#e65100' : '#c62828';
  const rows = (cac_cau || []).map(cau => {
    const statusColor = cau.trang_thai === 'Đúng' ? '#2e7d32' : cau.trang_thai === 'Một phần' ? '#e65100' : '#c62828';
    return `
      <tr>
        <td>${cau.so_cau}</td>
        <td style="color:${statusColor};font-weight:600">${cau.trang_thai}</td>
        <td style="text-align:center">${cau.diem_dat} / ${cau.diem_toi_da}</td>
        <td>${cau.nhan_xet || ''}</td>
        <td style="color:#c62828">${cau.loi_sai || ''}</td>
        <td style="color:#1565c0">${cau.goi_y_sua || ''}</td>
      </tr>`;
  }).join('');

  const images = imageFiles.map(f =>
    `<img src="/uploads/${f}" style="max-width:100%;border:1px solid #ddd;border-radius:8px;margin-bottom:12px">`
  ).join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kết quả chấm bài - ${studentName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Be Vietnam Pro', 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px; }
  .header { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; border-left: 6px solid ${scoreColor}; }
  .score-big { font-size: 52px; font-weight: 700; color: ${scoreColor}; }
  .score-label { font-size: 18px; color: #555; margin-top: 4px; }
  .xep-loai { display: inline-block; background: ${scoreColor}; color: #fff; padding: 4px 14px; border-radius: 20px; font-size: 15px; margin-top: 8px; }
  .nhan-xet { margin-top: 12px; padding: 12px; background: #f8f8f8; border-radius: 8px; font-size: 14px; line-height: 1.6; color: #444; }
  .section { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f0f0f0; padding: 10px 8px; text-align: left; font-weight: 600; }
  td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; line-height: 1.5; }
  tr:hover td { background: #fafafa; }
  .meta { font-size: 13px; color: #888; margin-top: 8px; }
  @media print {
    body { background: #fff; }
    .container { padding: 0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="meta">${subject} • ${new Date(createdAt).toLocaleString('vi-VN')}</div>
    <div style="font-size:22px;font-weight:600;margin-top:6px">${studentName}</div>
    <div class="score-big">${tong_diem}<span style="font-size:28px;color:#999">/${diem_toi_da}</span></div>
    <div class="score-label">${phan_tram}%</div>
    <span class="xep-loai">${xep_loai}</span>
    <div class="nhan-xet">${nhan_xet_chung || ''}</div>
  </div>

  <div class="section">
    <h2>📋 Chi tiết từng câu</h2>
    <table>
      <thead>
        <tr>
          <th>Câu</th><th>Trạng thái</th><th>Điểm</th><th>Nhận xét</th><th>Lỗi sai</th><th>Gợi ý sửa</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>🖼️ Bài làm học sinh</h2>
    ${images}
  </div>

  <div class="no-print" style="text-align:center;margin-top:20px">
    <button onclick="window.print()" style="padding:10px 28px;background:#1565c0;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">
      🖨️ In / Xuất PDF
    </button>
  </div>
</div>
</body>
</html>`;
}

module.exports = router;

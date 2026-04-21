const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '../uploads/rubrics'),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// POST /api/rubric/parse — upload file Word/JSON và parse thành rubric chuẩn
router.post('/parse', upload.single('file'), async (req, res) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Vui lòng upload file rubric' });
    }

    let textContent = '';
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: req.file.path });
      textContent = result.value;
    } else if (ext === '.json') {
      textContent = fs.readFileSync(req.file.path, 'utf8');
      try {
        const parsed = JSON.parse(textContent);
        return res.json({ success: true, rubric: parsed });
      } catch {
        return res.status(400).json({ error: 'File JSON không hợp lệ' });
      }
    } else if (ext === '.txt') {
      textContent = fs.readFileSync(req.file.path, 'utf8');
    } else {
      return res.status(400).json({ error: 'Chỉ chấp nhận file .docx, .json, .txt' });
    }

    // Dùng Claude để parse text thành rubric JSON chuẩn
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Hãy đọc nội dung đáp án/rubric sau và chuyển thành JSON theo cấu trúc chuẩn.

NỘI DUNG:
${textContent}

Trả về JSON CHÍNH XÁC (không thêm text), cấu trúc:
\`\`\`json
{
  "ten_de": "<tên đề thi/kiểm tra>",
  "mon_hoc": "<môn học>",
  "lop": "<lớp>",
  "tong_diem": <tổng điểm tối đa>,
  "thoi_gian": "<thời gian làm bài nếu có>",
  "cac_cau": [
    {
      "so_cau": "<Câu 1>",
      "noi_dung": "<nội dung câu hỏi>",
      "diem": <điểm tối đa>,
      "dap_an": "<đáp án chi tiết>",
      "tieu_chi": [
        { "mo_ta": "<tiêu chí chấm>", "diem": <điểm> }
      ]
    }
  ]
}
\`\`\``
      }]
    });

    const rawText = response.content[0].text;
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/(\{[\s\S]*\})/);
    const rubric = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);

    // Lưu rubric đã parse
    const rubricId = uuidv4();
    const rubricDir = path.join(__dirname, '../uploads/rubrics');
    fs.writeFileSync(
      path.join(rubricDir, `${rubricId}_parsed.json`),
      JSON.stringify(rubric, null, 2)
    );

    res.json({ success: true, rubricId, rubric });

  } catch (error) {
    console.error('Lỗi parse rubric:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/rubric/validate — kiểm tra rubric JSON có đúng chuẩn không (validate sâu)
router.post('/validate', (req, res) => {
  const { rubric } = req.body;
  const result = validateRubricDeep(rubric);
  res.json(result);
});

// Hàm validate sâu — export để dùng trong chỗ khác nếu cần
function validateRubricDeep(rubric) {
  const errors = [];   // lỗi chặn (không chấm được)
  const warnings = []; // cảnh báo (vẫn chấm được nhưng thầy nên xem)

  if (!rubric || typeof rubric !== 'object') {
    return { valid: false, errors: ['Rubric không phải object hợp lệ'], warnings: [] };
  }

  // 1. Thiếu tong_diem
  if (rubric.tong_diem === undefined || rubric.tong_diem === null) {
    errors.push('Thiếu tong_diem (tổng điểm tối đa)');
  }

  // 2. cac_cau phải là array
  if (!Array.isArray(rubric.cac_cau) || rubric.cac_cau.length === 0) {
    errors.push('Thiếu hoặc rỗng cac_cau (mảng các câu)');
    return { valid: errors.length === 0, errors, warnings };
  }

  // 3. Kiểm tra từng câu
  let tongDiemCau = 0;
  rubric.cac_cau.forEach((cau, i) => {
    const label = cau.so_cau || `Câu thứ ${i + 1}`;

    if (!cau.so_cau) {
      errors.push(`${label}: thiếu so_cau`);
    }
    if (cau.diem === undefined || cau.diem === null) {
      errors.push(`${label}: thiếu diem`);
    } else {
      tongDiemCau += Number(cau.diem);
    }
    if (!cau.dap_an) {
      warnings.push(`${label}: thiếu dap_an (Claude sẽ khó đối chiếu, nên bổ sung đáp án chi tiết)`);
    }
    if (!cau.noi_dung) {
      warnings.push(`${label}: thiếu noi_dung (nội dung câu hỏi)`);
    }

    // Kiểm tra tiêu chí
    if (Array.isArray(cau.tieu_chi) && cau.tieu_chi.length > 0) {
      const tongTC = cau.tieu_chi.reduce((s, tc) => s + Number(tc.diem || 0), 0);
      if (Number(cau.diem) > 0 && Math.abs(tongTC - Number(cau.diem)) > 0.01) {
        warnings.push(
          `${label}: tổng điểm tiêu chí (${tongTC}) không khớp điểm câu (${cau.diem})`
        );
      }
      cau.tieu_chi.forEach((tc, j) => {
        if (!tc.mo_ta) warnings.push(`${label} tiêu chí ${j + 1}: thiếu mo_ta`);
        if (tc.diem === undefined) warnings.push(`${label} tiêu chí ${j + 1}: thiếu diem`);
      });
    } else {
      // Không có tiêu chí → cảnh báo cho câu có dấu hiệu phải chấm quá trình
      const nd = String(cau.noi_dung || '').toLowerCase();
      if (/chứng minh|rút gọn|giải bài toán|vẽ đồ thị|lập phương trình/.test(nd)) {
        warnings.push(`${label}: câu dạng "${nd.slice(0, 40)}..." nên có tiêu chí chi tiết (AI sẽ tự tách khi chấm)`);
      } else {
        warnings.push(`${label}: chưa có tiêu chí (AI sẽ tự tách khi chấm)`);
      }
    }
  });

  // 4. Tổng điểm câu phải khớp tong_diem
  if (rubric.tong_diem && Math.abs(tongDiemCau - Number(rubric.tong_diem)) > 0.01) {
    warnings.push(
      `Tổng điểm các câu (${tongDiemCau}) không khớp tong_diem (${rubric.tong_diem})`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    tong_diem_cong_don: Math.round(tongDiemCau * 100) / 100
  };
}

module.exports = router;
module.exports.validateRubricDeep = validateRubricDeep;

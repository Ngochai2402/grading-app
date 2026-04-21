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

// POST /api/rubric/validate — kiểm tra rubric JSON có đúng chuẩn không
router.post('/validate', (req, res) => {
  const { rubric } = req.body;
  const errors = [];

  if (!rubric.cac_cau || !Array.isArray(rubric.cac_cau)) {
    errors.push('Thiếu trường cac_cau (mảng các câu hỏi)');
  } else {
    rubric.cac_cau.forEach((cau, i) => {
      if (!cau.so_cau) errors.push(`Câu ${i + 1}: thiếu so_cau`);
      if (cau.diem === undefined) errors.push(`Câu ${i + 1}: thiếu diem`);
      if (!cau.dap_an) errors.push(`Câu ${i + 1}: thiếu dap_an`);
    });
  }

  if (!rubric.tong_diem) errors.push('Thiếu tong_diem');

  res.json({ valid: errors.length === 0, errors });
});

module.exports = router;

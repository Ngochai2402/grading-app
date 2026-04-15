const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Cấu hình multer lưu ảnh bài làm
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WebP'));
  }
});

// POST /api/grade
// Body: multipart/form-data
//   - images[]: 1 hoặc nhiều ảnh bài làm
//   - rubric: JSON string chứa đáp án + thang điểm
//   - studentName: tên học sinh (optional)
//   - subject: môn học (optional)
router.post('/', (req, res, next) => {
  upload.array('images[]', 20)(req, res, (err) => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      upload.array('images', 20)(req, res, next);
    } else {
      next(err);
    }
  });
}, async (req, res) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    }
    if (!rubricStr) {
      return res.status(400).json({ error: 'Vui lòng cung cấp rubric (đáp án + thang điểm)' });
    }

    let rubric;
    try {
      rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr;
    } catch {
      return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' });
    }

    // Đọc và encode ảnh sang base64
    const imageContents = req.files.map(file => {
      const imageData = fs.readFileSync(file.path);
      const base64 = imageData.toString('base64');
      const mediaType = file.mimetype;
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 }
      };
    });

    // Xây dựng prompt chấm bài
    const gradingPrompt = buildGradingPrompt(rubric, studentName, subject);

    // Gọi Claude Vision
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContents,
            { type: 'text', text: gradingPrompt }
          ]
        }
      ]
    });

    // Parse kết quả JSON từ Claude
    const rawText = response.content[0].text;
    let gradingResult;
    try {
      const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : rawText;
      gradingResult = JSON.parse(jsonStr);
    } catch {
      return res.status(500).json({
        error: 'Claude trả về kết quả không đúng định dạng',
        raw: rawText
      });
    }

    // Lưu kết quả
    const resultId = uuidv4();
    const resultData = {
      id: resultId,
      studentName,
      subject,
      gradingResult,
      imageFiles: req.files.map(f => f.filename),
      rubric,
      createdAt: new Date().toISOString()
    };

    const resultsDir = path.join(__dirname, '../results');
    fs.writeFileSync(
      path.join(resultsDir, `${resultId}.json`),
      JSON.stringify(resultData, null, 2)
    );

    res.json({
      success: true,
      resultId,
      studentName,
      subject,
      gradingResult,
      imageUrls: req.files.map(f => `/uploads/${f.filename}`)
    });

  } catch (error) {
    console.error('Lỗi chấm bài:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/grade/:id — lấy kết quả đã chấm theo ID
router.get('/:id', (req, res) => {
  const filePath = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Không tìm thấy kết quả' });
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data);
});

// GET /api/grade — danh sách bài đã chấm
router.get('/', (req, res) => {
  const resultsDir = path.join(__dirname, '../results');
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
    return {
      id: data.id,
      studentName: data.studentName,
      subject: data.subject,
      tongDiem: data.gradingResult?.tong_diem,
      diemToiDa: data.gradingResult?.diem_toi_da,
      createdAt: data.createdAt
    };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

function buildGradingPrompt(rubric, studentName, subject) {
  return `Bạn là giáo viên chấm bài môn ${subject}. Hãy chấm bài làm của học sinh ${studentName}.

=== RUBRIC (ĐÁP ÁN + THANG ĐIỂM) ===
${JSON.stringify(rubric, null, 2)}

=== CÁCH CHẤM NHƯ GIÁO VIÊN TOÁN CHUYÊN NGHIỆP ===

BƯỚC 1 — ĐỌC BÀI TRƯỚC KHI CHẤM:
- Đọc TOÀN BỘ bài giải của học sinh từ đầu đến cuối
- Hiểu học sinh đang dùng phương pháp gì, hướng giải nào
- Ghi nhận tất cả các bước, kết quả có trong bài

BƯỚC 2 — ĐÁNH GIÁ TỪNG TIÊU CHÍ:
- Đối chiếu từng tiêu chí trong rubric với bài làm
- Nếu học sinh đạt tiêu chí đó (dù cách viết khác) → cho điểm tiêu chí đó
- Một bước được coi là đúng khi: kết quả đúng HOẶC lập luận đúng

BƯỚC 3 — NGUYÊN TẮC CHẤM CÔNG BẰNG:
- Cách trình bày khác đáp án nhưng bản chất toán học đúng → KHÔNG trừ điểm
- Học sinh dùng phương pháp khác (ngắn hơn/dài hơn) mà đúng → CHO ĐIỂM ĐẦY ĐỦ
- Chỉ trừ điểm khi: tính sai số, sai công thức, thiếu kết luận quan trọng, bỏ trống
- Sai nhỏ về trình bày (thiếu đơn vị, viết tắt) → trừ tối đa 0.25đ/câu
- Khi chữ viết khó đọc nhưng suy ra được kết quả đúng → cho điểm

BƯỚC 4 — NHẬN XÉT CHUYÊN NGHIỆP:
- Ghi nhận cụ thể những gì học sinh làm đúng
- Nếu có lỗi: chỉ ra đúng chỗ sai, giải thích tại sao sai
- Gợi ý sửa ngắn gọn, đúng trọng tâm

=== ĐỊNH DẠNG ĐẦU RA ===
Trả về JSON CHÍNH XÁC theo cấu trúc sau, không thêm text ngoài JSON:

\`\`\`json
{
  "tong_diem": <số điểm tổng>,
  "diem_toi_da": <tổng điểm tối đa>,
  "phan_tram": <phần trăm điểm, làm tròn 1 chữ số thập phân>,
  "xep_loai": "<Giỏi/Khá/Trung bình/Yếu>",
  "nhan_xet_chung": "<nhận xét tổng thể về bài làm>",
  "cac_cau": [
    {
      "so_cau": "<ví dụ: Câu 1>",
      "diem_dat": <điểm đạt được>,
      "diem_toi_da": <điểm tối đa câu này>,
      "trang_thai": "<Đúng/Một phần/Sai/Bỏ trống>",
      "nhan_xet": "<nhận xét cụ thể: học sinh làm gì đúng, sai ở đâu>",
      "loi_sai": "<mô tả lỗi sai nếu có, để trống nếu đúng>",
      "goi_y_sua": "<gợi ý cách sửa nếu có lỗi>"
    }
  ]
}
\`\`\`

Lưu ý: Nếu không đọc được một phần bài làm, ghi rõ trong nhan_xet. Chấm công bằng và khách quan.`;
}

module.exports = router;

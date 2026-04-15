const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WebP'));
  }
});

function uploadMiddleware(req, res, next) {
  upload.array('images[]', 20)(req, res, err => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') upload.array('images', 20)(req, res, next);
    else next(err);
  });
}

// ── GIAI ĐOẠN 1: Gemini đọc & gõ lại chữ viết tay ──────────────────────────
async function transcribeWithGemini(files, subject) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Chuẩn bị ảnh cho Gemini
  const imageParts = files.map(file => ({
    inlineData: {
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: file.mimetype
    }
  }));

  const prompt = `Bạn là chuyên gia OCR bài thi môn ${subject} bằng tiếng Việt.
Nhiệm vụ DUY NHẤT: GÕ LẠI chính xác toàn bộ nội dung bài làm học sinh trong ảnh.

NGUYÊN TẮC TUYỆT ĐỐI:
- Gõ lại CHÍNH XÁC từng ký tự, số, ký hiệu toán học — KHÔNG sửa, KHÔNG thêm, KHÔNG nhận xét
- Giữ nguyên cấu trúc xuống dòng như trong ảnh
- Ký hiệu toán: gõ đúng (x₁, x₂, √3, x², ≈, ⟹, △, ÷, ×, ≤, ≥)
- Phân số: gõ dạng a/b hoặc (a/b)
- Chữ mờ hoặc không đọc được: ghi [?]
- Hình vẽ/đồ thị: mô tả ngắn trong ngoặc [], ví dụ [Đồ thị parabol qua O, (-2;8), (2;8)]
- Gạch ngang, gạch dưới: ghi [gạch ngang] hoặc [gạch dưới]
- Nếu có nhiều ảnh: gõ lại tuần tự từng ảnh, phân biệt bằng [Trang 1], [Trang 2]...

Trả về JSON (không thêm text nào khác):
\`\`\`json
{
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "noi_dung_goc": [
        "dòng 1 học sinh viết",
        "dòng 2 học sinh viết"
      ]
    }
  ]
}
\`\`\``;

  const result = await model.generateContent([prompt, ...imageParts]);
  const text = result.response.text();
  const m = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
  return JSON.parse(m ? m[1] : text);
}

// ── GIAI ĐOẠN 2: Claude chấm từng dòng ──────────────────────────────────────
async function gradeWithClaude(transcribed, rubric, studentName, subject) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const baiLamText = transcribed.cac_cau
    .map(c => `${c.so_cau}:\n${c.noi_dung_goc.join('\n')}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    temperature: 0,
    messages: [{
      role: 'user',
      content: `Bạn là giáo viên ${subject} chuyên nghiệp với nhiều năm kinh nghiệm.
Chấm bài làm của học sinh ${studentName}.

=== BÀI LÀM HỌC SINH (đã được OCR chính xác) ===
${baiLamText}

=== RUBRIC (ĐÁP ÁN + THANG ĐIỂM) ===
${JSON.stringify(rubric, null, 2)}

=== CÁCH CHẤM TỪNG DÒNG ===
Với mỗi câu, lấy TỪNG DÒNG bài làm học sinh và chấm ngay dòng đó:
- ✓ Đúng — dòng này đúng hoàn toàn về mặt toán học
- ✗ Sai — dòng này sai, kèm giải thích: sai ở đâu, kết quả đúng phải là gì
- ~ Chấp nhận — đúng nhưng thiếu sót nhỏ về trình bày

NGUYÊN TẮC CHẤM:
- Đọc kỹ từng dòng, hiểu học sinh đang làm gì trước khi kết luận
- Cách trình bày khác đáp án nhưng BẢN CHẤT TOÁN HỌC ĐÚNG → ✓ cho điểm đầy đủ
- Học sinh dùng phương pháp tắt/ngắn hơn nhưng đúng → ✓
- Chỉ ✗ khi có lỗi toán học thực sự (tính sai, áp dụng sai công thức, kết quả sai)
- Thiếu đơn vị hoặc trình bày chưa hoàn chỉnh → ~ trừ tối đa 0.25đ
- Khi không chắc chắn → ưu tiên ✓

Trả về JSON:
\`\`\`json
{
  "tong_diem": 0,
  "diem_toi_da": 0,
  "phan_tram": 0.0,
  "xep_loai": "Giỏi",
  "nhan_xet_chung": "nhận xét tổng thể ngắn gọn",
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "diem_dat": 0,
      "diem_toi_da": 0,
      "trang_thai": "Đúng",
      "cham_tung_dong": [
        {
          "dong": "dòng học sinh viết chính xác",
          "ket_qua": "✓ Đúng",
          "ghi_chu": ""
        }
      ],
      "diem_tieu_chi": [
        { "tieu_chi": "tên tiêu chí", "dat": true, "diem": 0 }
      ],
      "loi_sai": "",
      "goi_y_sua": ""
    }
  ]
}
\`\`\``
    }]
  });

  const raw = response.content[0].text;
  const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/(\{[\s\S]*\})/);
  return JSON.parse(m ? m[1] : raw);
}

// ── POST /api/grade ── Main endpoint: Gemini transcribe → Claude grade
router.post('/', uploadMiddleware, async (req, res) => {
  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;

    if (!req.files?.length)
      return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    if (!rubricStr)
      return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });

    let rubric;
    try { rubric = JSON.parse(rubricStr); }
    catch { return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' }); }

    // Kiểm tra API keys
    if (!process.env.GEMINI_API_KEY)
      return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trong biến môi trường' });
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trong biến môi trường' });

    console.log(`[${studentName}] Bắt đầu giai đoạn 1: Gemini OCR...`);
    const transcribed = await transcribeWithGemini(req.files, subject);
    console.log(`[${studentName}] Giai đoạn 1 xong. Bắt đầu giai đoạn 2: Claude chấm...`);

    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);
    console.log(`[${studentName}] Hoàn thành. Điểm: ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`);

    const resultId = uuidv4();
    const resultData = {
      id: resultId, studentName, subject,
      gradingResult, transcribed,
      imageFiles: req.files.map(f => f.filename),
      rubric, createdAt: new Date().toISOString()
    };

    const resultsDir = path.join(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${resultId}.json`), JSON.stringify(resultData, null, 2));

    res.json({
      success: true, resultId, studentName, subject,
      gradingResult, transcribed,
      imageUrls: req.files.map(f => `/uploads/${f.filename}`)
    });

  } catch (error) {
    console.error('Lỗi chấm bài:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/grade/transcribe ── Chỉ OCR (dùng Gemini)
router.post('/transcribe', uploadMiddleware, async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    const { subject = 'Toán' } = req.body;
    const transcribed = await transcribeWithGemini(req.files, subject);

    const sessionId = uuidv4();
    const sessionsDir = path.join(__dirname, '../results/sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({ sessionId, imageFiles: req.files.map(f => f.filename), transcribed, createdAt: new Date().toISOString() }, null, 2)
    );

    res.json({ success: true, sessionId, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/grade/score ── Chỉ chấm (dùng Claude)
router.post('/score', async (req, res) => {
  try {
    const { sessionId, transcribed, rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!transcribed || !rubricStr) return res.status(400).json({ error: 'Thiếu dữ liệu' });

    let rubric;
    try { rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr; }
    catch { return res.status(400).json({ error: 'Rubric không đúng JSON' }); }

    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);

    let imageFiles = [];
    if (sessionId) {
      const sp = path.join(__dirname, '../results/sessions', `${sessionId}.json`);
      if (fs.existsSync(sp)) imageFiles = JSON.parse(fs.readFileSync(sp, 'utf8')).imageFiles;
    }

    const resultId = uuidv4();
    const resultData = { id: resultId, studentName, subject, gradingResult, transcribed, imageFiles, rubric, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, '../results', `${resultId}.json`), JSON.stringify(resultData, null, 2));

    res.json({ success: true, resultId, studentName, subject, gradingResult, transcribed, imageUrls: imageFiles.map(f => `/uploads/${f}`) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/grade/:id
router.get('/:id', (req, res) => {
  const fp = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

// ── GET /api/grade
router.get('/', (req, res) => {
  const dir = path.join(__dirname, '../results');
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: d.id, studentName: d.studentName, subject: d.subject, tongDiem: d.gradingResult?.tong_diem, diemToiDa: d.gradingResult?.diem_toi_da, createdAt: d.createdAt };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;

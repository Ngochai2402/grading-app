const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
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

function readImages(files) {
  return files.map(file => ({
    type: 'image',
    source: { type: 'base64', media_type: file.mimetype, data: fs.readFileSync(file.path).toString('base64') }
  }));
}

function uploadMiddleware(req, res, next) {
  upload.array('images[]', 20)(req, res, err => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') upload.array('images', 20)(req, res, next);
    else next(err);
  });
}

// ── POST /api/grade/transcribe ── Giai đoạn 1: chỉ đọc & gõ lại
router.post('/transcribe', uploadMiddleware, async (req, res) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    const { subject = 'Toán' } = req.body;
    const imageContents = readImages(req.files);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: `Bạn là người đọc bài thi môn ${subject}. Nhiệm vụ DUY NHẤT: GÕ LẠI chính xác toàn bộ bài làm học sinh.

NGUYÊN TẮC:
- Gõ lại CHÍNH XÁC từng ký tự, số, công thức — không sửa, không thêm, không nhận xét
- Giữ nguyên xuống dòng, thứ tự từng dòng
- Ký hiệu toán: gõ đúng (x₁, √3, x², ≈, ⟹, △, ÷)
- Chữ mờ/khó đọc: ghi [?]
- Hình vẽ/đồ thị: mô tả ngắn trong [], ví dụ [Đồ thị: parabol qua O, (-2;8), (2;8)]

Trả về JSON:
\`\`\`json
{"cac_cau":[{"so_cau":"Câu 1","noi_dung_goc":["dòng 1","dòng 2","..."]}]}
\`\`\`` }
        ]
      }]
    });

    const raw = response.content[0].text;
    const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/(\{[\s\S]*\})/);
    const transcribed = JSON.parse(m ? m[1] : raw);

    const sessionId = uuidv4();
    const sessionsDir = path.join(__dirname, '../results/sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({ sessionId, imageFiles: req.files.map(f => f.filename), transcribed, createdAt: new Date().toISOString() }, null, 2)
    );

    res.json({ success: true, sessionId, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    console.error('Lỗi transcribe:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/grade/score ── Giai đoạn 2: chấm từng dòng
router.post('/score', async (req, res) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const { sessionId, transcribed, rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!transcribed || !rubricStr) return res.status(400).json({ error: 'Thiếu nội dung bài làm hoặc rubric' });

    let rubric;
    try { rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr; }
    catch { return res.status(400).json({ error: 'Rubric không đúng JSON' }); }

    const baiLamText = transcribed.cac_cau
      .map(c => `${c.so_cau}:\n${c.noi_dung_goc.join('\n')}`)
      .join('\n\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Bạn là giáo viên ${subject} chuyên nghiệp. Chấm bài của học sinh ${studentName}.

=== BÀI LÀM HỌC SINH (đã gõ lại chính xác) ===
${baiLamText}

=== RUBRIC ===
${JSON.stringify(rubric, null, 2)}

=== CÁCH CHẤM TỪNG DÒNG ===
Với mỗi câu:
1. Lấy từng dòng bài làm học sinh (giữ nguyên chữ học sinh viết)
2. Chấm NGAY dòng đó:
   - ✓ Đúng — nếu đúng hoàn toàn
   - ✗ Sai — nếu sai, kèm giải thích ngắn + kết quả đúng phải là gì
   - ~ Chấp nhận — đúng nhưng còn thiếu sót nhỏ
3. Tổng kết điểm từng tiêu chí

NGUYÊN TẮC:
- Cách trình bày khác đáp án nhưng bản chất toán đúng → ✓ cho điểm đầy đủ
- Chỉ ✗ khi sai số, sai công thức, sai logic toán học thực sự
- Khi không chắc → ưu tiên ✓

Trả về JSON:
\`\`\`json
{
  "tong_diem": 0,
  "diem_toi_da": 0,
  "phan_tram": 0.0,
  "xep_loai": "Giỏi",
  "nhan_xet_chung": "",
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "diem_dat": 0,
      "diem_toi_da": 0,
      "trang_thai": "Đúng",
      "cham_tung_dong": [
        {
          "dong": "dòng học sinh viết",
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
    const gradingResult = JSON.parse(m ? m[1] : raw);

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
    console.error('Lỗi chấm:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/grade ── Tự động chạy 2 giai đoạn liên tiếp
router.post('/', uploadMiddleware, async (req, res) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    if (!rubricStr) return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });

    let rubric;
    try { rubric = JSON.parse(rubricStr); }
    catch { return res.status(400).json({ error: 'Rubric không đúng JSON' }); }

    const imageContents = readImages(req.files);

    // Giai đoạn 1: Transcribe
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096, temperature: 0,
      messages: [{ role: 'user', content: [
        ...imageContents,
        { type: 'text', text: `Gõ lại CHÍNH XÁC từng dòng bài làm học sinh môn ${subject}. Không sửa, không nhận xét. Chữ khó đọc ghi [?]. Hình vẽ mô tả trong []. JSON: {"cac_cau":[{"so_cau":"Câu 1","noi_dung_goc":["dòng 1","dòng 2"]}]}` }
      ]}]
    });
    const t1 = r1.content[0].text;
    const m1 = t1.match(/```json\n?([\s\S]*?)\n?```/) || t1.match(/(\{[\s\S]*\})/);
    const transcribed = JSON.parse(m1 ? m1[1] : t1);

    const baiLamText = transcribed.cac_cau.map(c => `${c.so_cau}:\n${c.noi_dung_goc.join('\n')}`).join('\n\n');

    // Giai đoạn 2: Chấm
    const r2 = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8192, temperature: 0,
      messages: [{ role: 'user', content: `Giáo viên ${subject} chuyên nghiệp. Chấm bài ${studentName}.\n\n=== BÀI LÀM ===\n${baiLamText}\n\n=== RUBRIC ===\n${JSON.stringify(rubric, null, 2)}\n\nChấm từng dòng: ✓ Đúng / ✗ Sai (giải thích) / ~ Chấp nhận. Cách khác nhưng đúng → ✓. Trả về JSON đầy đủ với cham_tung_dong cho mỗi câu.` }]
    });
    const t2 = r2.content[0].text;
    const m2 = t2.match(/```json\n?([\s\S]*?)\n?```/) || t2.match(/(\{[\s\S]*\})/);
    const gradingResult = JSON.parse(m2 ? m2[1] : t2);

    const resultId = uuidv4();
    const resultData = { id: resultId, studentName, subject, gradingResult, transcribed, imageFiles: req.files.map(f => f.filename), rubric, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, '../results', `${resultId}.json`), JSON.stringify(resultData, null, 2));

    res.json({ success: true, resultId, studentName, subject, gradingResult, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    console.error('Lỗi:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/grade/:id
router.get('/:id', (req, res) => {
  const fp = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

// GET /api/grade
router.get('/', (req, res) => {
  const dir = path.join(__dirname, '../results');
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: d.id, studentName: d.studentName, subject: d.subject, tongDiem: d.gradingResult?.tong_diem, diemToiDa: d.gradingResult?.diem_toi_da, createdAt: d.createdAt };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;

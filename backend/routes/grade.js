const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

/* ============================================================================
 * Upload config
 * ========================================================================== */
const uploadsDir = path.join(__dirname, '../uploads');
const resultsDir = path.join(__dirname, '../results');
const sessionsDir = path.join(__dirname, '../results/sessions');

[uploadsDir, resultsDir, sessionsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WebP'));
  }
});

function uploadMiddleware(req, res, next) {
  upload.array('images[]', 20)(req, res, err => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      return upload.array('images', 20)(req, res, next);
    }
    return next(err);
  });
}

/* ============================================================================
 * Helpers
 * ========================================================================== */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeReadFileBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

function extractJsonBlock(text) {
  if (!text || typeof text !== 'string') return '';

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const genericFenced = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
  if (genericFenced) return genericFenced[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  return text.trim();
}

function repairJson(str) {
  let s = String(str || '').trim();
  if (!s) return s;

  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/\t/g, '  ');

  let result = '';
  let inStr = false;
  let esc = false;
  const stack = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (esc) {
      result += c;
      esc = false;
      continue;
    }

    if (c === '\\' && inStr) {
      result += c;
      esc = true;
      continue;
    }

    if (c === '"') {
      result += c;
      inStr = !inStr;
      continue;
    }

    if (!inStr) {
      if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if ((c === '}' || c === ']') && stack.length && stack[stack.length - 1] === c) {
        stack.pop();
      }
    }

    result += c;
  }

  result = result.replace(/,\s*([}\]])/g, '$1').trim();

  if (stack.length > 0) {
    result += stack.reverse().join('');
  }

  return result;
}

function parseJsonSafe(rawText, fallback = null) {
  const extracted = extractJsonBlock(rawText);
  const repaired = repairJson(extracted);

  try {
    return JSON.parse(repaired);
  } catch (err1) {
    try {
      const fixed = repaired
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      return JSON.parse(fixed);
    } catch (err2) {
      if (fallback !== null) return fallback;
      throw new Error(`Không parse được JSON từ AI. Lỗi: ${err2.message}`);
    }
  }
}

function normalizeArray(val) {
  return Array.isArray(val) ? val : [];
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function buildRubricMap(rubric) {
  const map = new Map();
  const cauList = normalizeArray(rubric?.cac_cau);

  for (const cau of cauList) {
    map.set(String(cau.so_cau || '').trim(), {
      so_cau: String(cau.so_cau || '').trim(),
      noi_dung: cau.noi_dung || '',
      diem: Number(cau.diem || 0),
      dap_an: cau.dap_an || '',
      tieu_chi: normalizeArray(cau.tieu_chi).map(tc => ({
        mo_ta: tc.mo_ta || '',
        diem: Number(tc.diem || 0)
      }))
    });
  }

  return map;
}

function makeEmptyQuestionScore(rubricQuestion) {
  const tieuChi = normalizeArray(rubricQuestion?.tieu_chi).map(tc => ({
    tieu_chi: tc.mo_ta || '',
    dat: false,
    diem: 0
  }));

  return {
    so_cau: rubricQuestion?.so_cau || '',
    diem_dat: 0,
    diem_toi_da: Number(rubricQuestion?.diem || 0),
    trang_thai: 'Sai',
    cham_tung_dong: [],
    diem_tieu_chi: tieuChi,
    loi_sai: 'Không có bài làm hoặc không đạt tiêu chí.',
    goi_y_sua: ''
  };
}

function normalizeClaudeQuestion(aiQuestion, rubricQuestion) {
  const q = aiQuestion || {};
  const rq = rubricQuestion || {};
  const rubricCriteria = normalizeArray(rq.tieu_chi);

  let diemTieuChi = normalizeArray(q.diem_tieu_chi).map((item, idx) => {
    const rubricTc = rubricCriteria[idx] || {};
    const maxDiem = Number(rubricTc.diem || 0);

    let dat = false;
    if (typeof item?.dat === 'boolean') dat = item.dat;
    else if (typeof item?.dat === 'string') {
      const s = item.dat.trim().toLowerCase();
      dat = ['true', '1', 'yes', 'đúng', 'dat', 'đạt'].includes(s);
    }

    let diem = Number(item?.diem || 0);
    if (!Number.isFinite(diem) || diem < 0) diem = 0;
    if (diem > maxDiem) diem = maxDiem;

    if (dat && diem === 0 && maxDiem > 0) {
      diem = maxDiem;
    }

    if (!dat) {
      diem = 0;
    }

    return {
      tieu_chi: item?.tieu_chi || rubricTc.mo_ta || `Tiêu chí ${idx + 1}`,
      dat,
      diem: round2(diem)
    };
  });

  if (diemTieuChi.length < rubricCriteria.length) {
    for (let i = diemTieuChi.length; i < rubricCriteria.length; i++) {
      diemTieuChi.push({
        tieu_chi: rubricCriteria[i].mo_ta || `Tiêu chí ${i + 1}`,
        dat: false,
        diem: 0
      });
    }
  }

  const diemDat = round2(diemTieuChi.reduce((sum, x) => sum + Number(x.diem || 0), 0));
  const diemToiDa = Number(rq.diem || 0);

  let trangThai = q.trang_thai || '';
  if (!trangThai) {
    trangThai = diemDat > 0 ? 'Đúng một phần' : 'Sai';
  }

  const chamTungDong = normalizeArray(q.cham_tung_dong).map(item => ({
    dong: item?.dong || '',
    ket_qua: item?.ket_qua === '✓ Đúng' ? '✓ Đúng' : '✗ Sai',
    ghi_chu: item?.ghi_chu || ''
  }));

  return {
    so_cau: q.so_cau || rq.so_cau || '',
    diem_dat: diemDat > diemToiDa ? diemToiDa : diemDat,
    diem_toi_da: diemToiDa,
    trang_thai: trangThai,
    cham_tung_dong: chamTungDong,
    diem_tieu_chi: diemTieuChi,
    loi_sai: q.loi_sai || '',
    goi_y_sua: q.goi_y_sua || ''
  };
}

function recalcFinalScore(parsed, rubric, transcribed) {
  const rubricMap = buildRubricMap(rubric);
  const aiQuestions = normalizeArray(parsed?.cac_cau);
  const transcribedQuestions = normalizeArray(transcribed?.cac_cau);

  const transcribedMap = new Map();
  for (const q of transcribedQuestions) {
    transcribedMap.set(String(q.so_cau || '').trim(), q);
  }

  const aiMap = new Map();
  for (const q of aiQuestions) {
    aiMap.set(String(q.so_cau || '').trim(), q);
  }

  const finalQuestions = [];

  for (const [soCau, rubricQuestion] of rubricMap.entries()) {
    const transcribedQuestion = transcribedMap.get(soCau);
    const aiQuestion = aiMap.get(soCau);

    const isBlank =
      !transcribedQuestion ||
      !Array.isArray(transcribedQuestion.noi_dung_goc) ||
      transcribedQuestion.noi_dung_goc.length === 0 ||
      transcribedQuestion.noi_dung_goc.every(line => !String(line || '').trim());

    if (isBlank) {
      finalQuestions.push(makeEmptyQuestionScore(rubricQuestion));
      continue;
    }

    finalQuestions.push(normalizeClaudeQuestion(aiQuestion, rubricQuestion));
  }

  const tongDiem = round2(finalQuestions.reduce((sum, q) => sum + Number(q.diem_dat || 0), 0));
  const diemToiDa = Number(rubric?.tong_diem || finalQuestions.reduce((sum, q) => sum + Number(q.diem_toi_da || 0), 0));
  const phanTram = diemToiDa > 0 ? round1((tongDiem / diemToiDa) * 100) : 0;
  const xepLoai = phanTram >= 80 ? 'Giỏi' : phanTram >= 65 ? 'Khá' : phanTram >= 50 ? 'Trung bình' : 'Yếu';

  return {
    tong_diem: tongDiem,
    diem_toi_da: diemToiDa,
    phan_tram: phanTram,
    xep_loai: xepLoai,
    nhan_xet_chung: parsed?.nhan_xet_chung || '',
    cac_cau: finalQuestions
  };
}

/* ============================================================================
 * Phase 1: Gemini OCR / transcription
 * ========================================================================== */
async function transcribeWithGemini(files, subject) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const imageParts = files.map(file => ({
    inlineData: {
      data: safeReadFileBase64(file.path),
      mimeType: file.mimetype
    }
  }));

  const prompt = `Bạn là chuyên gia OCR bài thi môn ${subject} bằng tiếng Việt, đặc biệt giỏi đọc ký hiệu toán học viết tay.

NHIỆM VỤ DUY NHẤT:
- Gõ lại trung thực toàn bộ bài làm học sinh từ ảnh
- KHÔNG chấm điểm
- KHÔNG sửa bài
- KHÔNG nhận xét
- KHÔNG suy luận thêm nếu không chắc

QUY TẮC CỰC KỲ QUAN TRỌNG:
1. Giữ nguyên nội dung học sinh viết
2. Giữ nguyên thứ tự dòng
3. Nếu mờ/khó đọc: ghi "[?]"
4. Nếu có hình vẽ/đồ thị: mô tả ngắn trong []
5. Nếu có nhiều ảnh: ghi rõ [Trang 1], [Trang 2], ...
6. Phân biệt thật kỹ:
   - 7/2 khác -7
   - x1, x2 khác x^2
   - (7/2)^2 khác (-7)^2
   - 3.2 trong bài làm toán phổ thông có thể là 3×2, không tự đổi thành số thập phân nếu không chắc

YÊU CẦU ĐẦU RA:
- Trả về JSON hợp lệ
- Không thêm giải thích ngoài JSON

MẪU:
\`\`\`json
{
  "cac_cau": [
    {
      "so_cau": "Câu 1a",
      "noi_dung_goc": [
        "dòng 1",
        "dòng 2"
      ]
    }
  ]
}
\`\`\``;

  let raw = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent([prompt, ...imageParts]);
      raw = result.response.text();
      break;
    } catch (err) {
      const msg = err?.message || '';
      const overload =
        msg.includes('503') ||
        msg.toLowerCase().includes('overloaded') ||
        msg.toLowerCase().includes('unavailable');

      if (attempt === 3 || !overload) throw err;

      console.log(`Gemini quá tải, thử lại lần ${attempt + 1}...`);
      await sleep(3000 * attempt);
    }
  }

  const parsed = parseJsonSafe(raw, { cac_cau: [] });

  if (!Array.isArray(parsed.cac_cau)) {
    parsed.cac_cau = [];
  }

  parsed.cac_cau = parsed.cac_cau.map(item => ({
    so_cau: String(item?.so_cau || '').trim(),
    noi_dung_goc: normalizeArray(item?.noi_dung_goc).map(x => String(x || ''))
  }));

  return parsed;
}

/* ============================================================================
 * Phase 2: Claude grading
 * ========================================================================== */
async function gradeWithClaude(transcribed, rubric, studentName, subject) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const baiLamText = normalizeArray(transcribed?.cac_cau)
    .map(c => `${c.so_cau}:\n${normalizeArray(c.noi_dung_goc).join('\n')}`)
    .join('\n\n');

  const prompt = `Bạn là giáo viên ${subject} chuyên nghiệp. Hãy chấm bài học sinh ${studentName}.

=== BÀI LÀM (đã OCR) ===
${baiLamText}

=== ĐÁP ÁN / RUBRIC CHÍNH THỨC ===
${JSON.stringify(rubric, null, 2)}

=== NGUYÊN TẮC BẮT BUỘC ===
1. PHẢI bám tuyệt đối vào rubric chính thức.
2. KHÔNG được tranh luận với đáp án chính thức.
3. KHÔNG được viết kiểu:
   - "rubric có thể sai"
   - "đề có thể chép nhầm"
   - "nếu theo cách này thì đáp án khác"
4. Nếu bài làm không khớp đáp án chính thức thì chấm theo rubric chính thức.
5. Có thể cho điểm nếu học sinh làm cách khác nhưng VẪN đúng toán và VẪN thỏa tiêu chí rubric.
6. Nếu bài bỏ trống thì 0 điểm.
7. Mỗi tiêu chí chỉ được chấm trong khoảng từ 0 đến số điểm tối đa của tiêu chí đó.
8. Không tự cộng điểm vượt quá điểm tối đa của câu.
9. Nhận xét ngắn gọn, rõ lỗi chính, không lan man.

=== QUY TẮC TRÌNH BÀY "cham_tung_dong" ===
- Tách chữ tiếng Việt và công thức toán
- Chữ tiếng Việt: viết ngoài dấu $
- Công thức, biểu thức, số, biến: viết trong $...$
- Ví dụ đúng:
  "Thay $y = 2x$ vào $y = -2x^2$ được $2x = -2x^2$"

=== "ket_qua" ===
- Chỉ ghi đúng một trong hai giá trị:
  - "✓ Đúng"
  - "✗ Sai"

=== "ghi_chu" ===
- Có thể để trống ""
- Nếu cần ghi, chỉ ghi ngắn gọn, tuyệt đối không nghi ngờ lại rubric

=== ĐẦU RA ===
Trả về JSON hợp lệ, không thêm văn bản nào ngoài JSON:

\`\`\`json
{
  "tong_diem": 0,
  "diem_toi_da": 0,
  "phan_tram": 0,
  "xep_loai": "Yếu",
  "nhan_xet_chung": "nhận xét ngắn gọn",
  "cac_cau": [
    {
      "so_cau": "Câu 1a",
      "diem_dat": 0,
      "diem_toi_da": 0,
      "trang_thai": "Đúng một phần",
      "cham_tung_dong": [
        {
          "dong": "dòng học sinh viết",
          "ket_qua": "✓ Đúng",
          "ghi_chu": ""
        }
      ],
      "diem_tieu_chi": [
        {
          "tieu_chi": "mô tả tiêu chí",
          "dat": true,
          "diem": 0.5
        }
      ],
      "loi_sai": "",
      "goi_y_sua": ""
    }
  ]
}
\`\`\``;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });

  const rawText = response?.content?.[0]?.text || '';
  let jsonText = extractJsonBlock(rawText);

  jsonText = jsonText.replace(/(?<!\\)\\(?=[a-zA-Z])/g, '\\\\');
  jsonText = repairJson(jsonText);

  const parsed = parseJsonSafe(jsonText, {
    tong_diem: 0,
    diem_toi_da: rubric?.tong_diem || 0,
    phan_tram: 0,
    xep_loai: 'Yếu',
    nhan_xet_chung: '',
    cac_cau: []
  });

  return recalcFinalScore(parsed, rubric, transcribed);
}

/* ============================================================================
 * Routes
 * ========================================================================== */

// POST /api/grade
// Main flow: upload -> Gemini OCR -> Claude grade
router.post('/', uploadMiddleware, async (req, res) => {
  try {
    const {
      rubric: rubricStr,
      studentName = 'Học sinh',
      subject = 'Bài kiểm tra'
    } = req.body;

    if (!req.files?.length) {
      return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    }

    if (!rubricStr) {
      return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });
    }

    let rubric;
    try {
      rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr;
    } catch {
      return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trong biến môi trường' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trong biến môi trường' });
    }

    console.log(`[${studentName}] Bắt đầu OCR bằng Gemini...`);
    const transcribed = await transcribeWithGemini(req.files, subject);

    console.log(`[${studentName}] OCR xong, bắt đầu chấm bằng Claude...`);
    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);

    console.log(
      `[${studentName}] Hoàn thành. Điểm: ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`
    );

    const resultId = uuidv4();
    const resultData = {
      id: resultId,
      studentName,
      subject,
      gradingResult,
      transcribed,
      imageFiles: req.files.map(f => f.filename),
      rubric,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(resultsDir, `${resultId}.json`),
      JSON.stringify(resultData, null, 2),
      'utf8'
    );

    return res.json({
      success: true,
      resultId,
      studentName,
      subject,
      gradingResult,
      transcribed,
      imageUrls: req.files.map(f => `/uploads/${f.filename}`)
    });
  } catch (error) {
    console.error('Lỗi chấm bài:', error);
    return res.status(500).json({ error: error.message || 'Lỗi không xác định' });
  }
});

// POST /api/grade/transcribe
// OCR only
router.post('/transcribe', uploadMiddleware, async (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trong biến môi trường' });
    }

    const { subject = 'Toán' } = req.body;
    const transcribed = await transcribeWithGemini(req.files, subject);
    const sessionId = uuidv4();

    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(
        {
          sessionId,
          imageFiles: req.files.map(f => f.filename),
          transcribed,
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );

    return res.json({
      success: true,
      sessionId,
      transcribed,
      imageUrls: req.files.map(f => `/uploads/${f.filename}`)
    });
  } catch (error) {
    console.error('Lỗi OCR:', error);
    return res.status(500).json({ error: error.message || 'Lỗi không xác định' });
  }
});

// POST /api/grade/score
// Grade only
router.post('/score', async (req, res) => {
  try {
    const {
      sessionId,
      transcribed,
      rubric: rubricStr,
      studentName = 'Học sinh',
      subject = 'Bài kiểm tra'
    } = req.body;

    if (!transcribed || !rubricStr) {
      return res.status(400).json({ error: 'Thiếu dữ liệu' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trong biến môi trường' });
    }

    let rubric;
    try {
      rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr;
    } catch {
      return res.status(400).json({ error: 'Rubric không đúng JSON' });
    }

    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);

    let imageFiles = [];
    if (sessionId) {
      const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(sessionPath)) {
        const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        imageFiles = normalizeArray(sessionData.imageFiles);
      }
    }

    const resultId = uuidv4();
    const resultData = {
      id: resultId,
      studentName,
      subject,
      gradingResult,
      transcribed,
      imageFiles,
      rubric,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(resultsDir, `${resultId}.json`),
      JSON.stringify(resultData, null, 2),
      'utf8'
    );

    return res.json({
      success: true,
      resultId,
      studentName,
      subject,
      gradingResult,
      transcribed,
      imageUrls: imageFiles.map(f => `/uploads/${f}`)
    });
  } catch (error) {
    console.error('Lỗi chấm điểm:', error);
    return res.status(500).json({ error: error.message || 'Lỗi không xác định' });
  }
});

// GET /api/grade/:id
router.get('/:id', (req, res) => {
  try {
    const filePath = path.join(resultsDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Không tìm thấy' });
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return res.json(data);
  } catch (error) {
    console.error('Lỗi đọc kết quả:', error);
    return res.status(500).json({ error: error.message || 'Lỗi không xác định' });
  }
});

// GET /api/grade
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(resultsDir)) {
      return res.json([]);
    }

    const list = fs.readdirSync(resultsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const filePath = path.join(resultsDir, name);
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          id: d.id,
          studentName: d.studentName,
          subject: d.subject,
          tongDiem: d.gradingResult?.tong_diem,
          diemToiDa: d.gradingResult?.diem_toi_da,
          createdAt: d.createdAt
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json(list);
  } catch (error) {
    console.error('Lỗi lấy danh sách kết quả:', error);
    return res.status(500).json({ error: error.message || 'Lỗi không xác định' });
  }
});

module.exports = router;
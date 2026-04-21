// ─────────────────────────────────────────────────────────────────────────────
// grade.js — Phiên bản TỐI GIẢN (v3)
//
// Nguyên tắc:
//   1. CHỈ chấm đúng/sai từng dòng. Đúng = không ghi gì. Sai = ghi chỗ sai (≤1 câu).
//   2. Cột "dong" (bài làm HS) TUYỆT ĐỐI không sửa — Claude chỉ trả dong_index,
//      backend tự điền dong từ OCR gốc.
//   3. Tính điểm theo RUBRIC:
//      - Câu có "tieu_chi" với điểm > 0 → cộng điểm các tieu_chi đạt.
//      - Câu KHÔNG có "tieu_chi" → bỏ trống=0, toàn đúng=full,
//        có sai thì tính theo tỉ lệ (số dòng đúng / tổng dòng) × điểm tối đa.
//   4. Bỏ verify.js (đã có dong_index strict), bỏ nhan_xet_chung, loi_sai tổng.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const { textToKatex } = require('./latex-utils');

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
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      upload.array('images', 20)(req, res, next);
      return;
    }
    next(err);
  });
}

// ════════════════════════════════════════════════════════════════
// GIAI ĐOẠN 1: Gemini OCR — chỉ chép lại, không tính toán
// ════════════════════════════════════════════════════════════════
async function transcribeWithGemini(files, subject) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });

  const imageParts = files.map(file => ({
    inlineData: {
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: file.mimetype
    }
  }));

  const prompt = `Bạn là MÁY QUÉT bài thi môn ${subject}. Bạn KHÔNG phải giáo viên. Bạn KHÔNG tính toán.

NHIỆM VỤ DUY NHẤT: Chép lại CHÍNH XÁC TỪNG KÝ TỰ học sinh viết. Không thêm bớt, không sửa.

TUYỆT ĐỐI CẤM:
1. CẤM sửa phép tính dù HS viết sai. HS viết "Δ = 20" → ghi đúng "Δ = 20".
2. CẤM thêm chú thích "(sai)", "(đúng)", "(HS viết...)".
3. Không đọc rõ ký tự → ghi [?]. KHÔNG đoán.
4. CẤM bỏ dòng nào, kể cả dòng gạch xóa.
5. CẤM gộp 2 dòng thành 1.

QUY TẮC VIẾT CÔNG THỨC (ưu tiên LaTeX trong $...$):
- Phân số dọc: $\\dfrac{a}{b}$. Ngang: a/b.
- Lũy thừa: $x^2$, $x^{10}$.
- Chỉ số dưới: $x_1$, $a_{ij}$.
- Căn: $\\sqrt{21}$, $\\sqrt[3]{8}$.
- Chữ Hy Lạp: $\\Delta$, $\\alpha$, $\\pi$.
- Tam giác: $\\triangle ABC$.
- Mũi tên: $\\Rightarrow$, $\\Leftrightarrow$.
- Dấu ≤ ≥ ≠: $\\leq$, $\\geq$, $\\neq$.

PHÂN CÂU:
- Mỗi câu (Câu 1, Bài 1a, …) = 1 phần tử trong "cac_cau".
- "so_cau" = đúng chuỗi HS viết.
- "noi_dung_goc" = mảng các dòng, mỗi phần tử là 1 dòng HS viết.

Trả về JSON thuần (không markdown):
{
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "noi_dung_goc": ["dòng 1", "dòng 2"]
    }
  ]
}`;

  const isTransient = (err) => {
    const msg = (err?.message || '') + '';
    return /503|overloaded|unavailable|fetch failed|ECONNRESET|ETIMEDOUT|network|timeout/i.test(msg);
  };

  let text = '';
  let currentModel = model;
  let currentName = modelName;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await currentModel.generateContent([prompt, ...imageParts]);
      text = result.response.text();
      break;
    } catch (err) {
      console.warn(`[Gemini] ${currentName} attempt ${attempt}: ${err.message}`);
      if (attempt === 3) throw err;
      if (!isTransient(err)) throw err;
      if (attempt === 2 && currentName !== 'gemini-2.5-flash') {
        currentName = 'gemini-2.5-flash';
        currentModel = genAI.getGenerativeModel({
          model: currentName,
          generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        });
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  const m = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/({[\s\S]*})/);
  return JSON.parse(m ? m[1] : text);
}

// ════════════════════════════════════════════════════════════════
// GIAI ĐOẠN 2: Claude chấm — CHỈ đúng/sai từng dòng + đạt/không từng tiêu chí
// ════════════════════════════════════════════════════════════════
async function gradeWithClaude(transcribed, rubric, studentName, subject) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Đánh index toàn bộ dòng → Claude chỉ tham chiếu số
  const indexedLines = [];
  (transcribed.cac_cau || []).forEach(cau => {
    (cau.noi_dung_goc || []).forEach(dong => {
      indexedLines.push({ cau: cau.so_cau, dong });
    });
  });

  const indexedText = indexedLines
    .map((item, idx) => `[${idx}] (${item.cau}) ${item.dong}`)
    .join('\n');

  // Build rubric: liệt kê từng câu + tiêu chí CÓ ĐIỂM
  const rubricSpec = (rubric.cac_cau || []).map(cau => {
    const tcList = (cau.tieu_chi || [])
      .filter(tc => Number(tc.diem || 0) > 0)
      .map((tc, idx) => `    [TC${idx}] "${tc.mo_ta}" — ${tc.diem}đ`)
      .join('\n');
    const tcSection = tcList
      ? `  Tiêu chí chấm (MỖI tiêu chí đạt được tính điểm tương ứng):\n${tcList}`
      : `  (Không có tiêu chí chi tiết — chấm đúng/sai tổng thể câu ${cau.diem}đ)`;
    return `• ${cau.so_cau} (tối đa ${cau.diem}đ):
  Đề: ${cau.noi_dung || '(không có)'}
  Đáp án chuẩn: ${cau.dap_an || '(không có)'}
${tcSection}`;
  }).join('\n\n');

  const rubricCauList = (rubric.cac_cau || []).map(c => c.so_cau).join(', ');
  const lastIdx = Math.max(indexedLines.length - 1, 0);

  const prompt = `Bạn là giáo viên ${subject} chấm bài học sinh ${studentName}.

=== BÀI LÀM (mỗi dòng có [n] ở đầu) ===
${indexedText || '(Học sinh không viết gì)'}

=== RUBRIC ===
${rubricSpec}

Số câu cần chấm: ${(rubric.cac_cau || []).length} — ${rubricCauList}

=== QUY TẮC ===

A. THAM CHIẾU DÒNG (bắt buộc):
- MỖI entry trong "cham_tung_dong" phải có "dong_index" là SỐ NGUYÊN từ 0 đến ${lastIdx}.
- TUYỆT ĐỐI KHÔNG viết lại nội dung dòng — CHỈ điền số index.
- Không dùng lại cùng 1 dong_index trong cùng 1 câu.
- Entry không có dong_index hợp lệ sẽ bị backend LOẠI BỎ.

B. CHẤM TỪNG DÒNG — NGUYÊN TẮC CHÍNH:
- "ket_qua" = "✓" hoặc "✗" (CHỈ 2 ký tự này, không gì khác).
- Nếu dòng ĐÚNG → "ghi_chu" = "" (RỖNG, không ghi gì).
- Nếu dòng SAI → "ghi_chu" = 1 câu NGẮN chỉ ra chỗ sai (VD: "Sai dấu", "Kết quả sai: phải là x=4", "Nhầm công thức").
- CẤM viết hướng dẫn sửa dạng "Hãy...", "Nên...", "Cần...".
- Phải đưa MỌI dòng HS viết vào cham_tung_dong (cả đúng và sai) để thầy thấy đầy đủ.

C. CHẤM TIÊU CHÍ (để backend tính điểm):
- Nếu câu có tiêu chí [TC0], [TC1]...: trả về "diem_tieu_chi" theo ĐÚNG thứ tự đó.
- Mỗi phần tử: { "tieu_chi_index": <số>, "dat": true|false }
- "dat" = true CHỈ KHI học sinh thực sự đáp ứng tiêu chí. Không rõ → false.
- Nếu câu KHÔNG có tiêu chí: trả "diem_tieu_chi": [] (mảng rỗng) — backend sẽ tính theo tỉ lệ dòng đúng.

D. TRANG THAI:
- "trang_thai" ∈ { "Đúng", "Đúng một phần", "Sai", "Bỏ trống" }.
- HS bỏ trống câu → trang_thai = "Bỏ trống", cham_tung_dong = [], diem_tieu_chi tất cả dat=false.

E. PHẢI CHẤM ĐỦ ${(rubric.cac_cau || []).length} CÂU: ${rubricCauList}.

Trả về JSON thuần (không markdown, không text khác):
{
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "trang_thai": "Đúng một phần",
      "cham_tung_dong": [
        { "dong_index": 0, "ket_qua": "✓", "ghi_chu": "" },
        { "dong_index": 1, "ket_qua": "✗", "ghi_chu": "Sai dấu trừ" }
      ],
      "diem_tieu_chi": [
        { "tieu_chi_index": 0, "dat": true },
        { "tieu_chi_index": 1, "dat": false }
      ]
    }
  ]
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content?.[0]?.text || '';
  const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/({[\s\S]*})/);
  let jsonStr = m ? m[1] : raw;
  jsonStr = repairJson(jsonStr);

  const parsed = JSON.parse(jsonStr);

  // ── LỚP BẢO VỆ: chỉ chấp nhận entry có dong_index hợp lệ ──
  const droppedByCau = new Map();
  (parsed.cac_cau || []).forEach(cau => {
    const usedIdx = new Set();
    const kept = [];
    const dropped = [];
    for (const d of (cau.cham_tung_dong || [])) {
      const rawIdx = d.dong_index;
      const idx = typeof rawIdx === 'number' ? rawIdx : parseInt(rawIdx);

      if (isNaN(idx) || !indexedLines[idx]) {
        dropped.push({ reason: 'invalid_dong_index', data: { ...d } });
        continue;
      }
      if (usedIdx.has(idx)) {
        dropped.push({ reason: 'duplicate_dong_index', data: { ...d } });
        continue;
      }
      usedIdx.add(idx);

      // LUÔN ghi đè dong bằng OCR gốc — Claude không thể sửa nội dung
      d.dong = indexedLines[idx].dong;
      delete d.dong_index;

      // Chuẩn hóa ket_qua
      const kq = String(d.ket_qua || '').trim();
      d.ket_qua = (kq.includes('✓') || kq.toLowerCase().includes('đúng')) ? '✓' : '✗';

      // Đúng → xóa ghi_chu; sai → giữ ghi_chu ngắn
      if (d.ket_qua === '✓') {
        d.ghi_chu = '';
      } else {
        d.ghi_chu = stripForbiddenContent(d.ghi_chu || '');
      }

      kept.push(d);
    }
    cau.cham_tung_dong = kept;
    if (dropped.length > 0) droppedByCau.set(cau.so_cau, dropped);
  });

  if (droppedByCau.size > 0) {
    const total = Array.from(droppedByCau.values()).reduce((s, a) => s + a.length, 0);
    console.warn(`[STRICT] Đã drop ${total} entry Claude bịa từ ${droppedByCau.size} câu`);
    parsed.canh_bao_hallucination = {
      co_bia_dong: true,
      so_cau_bi_bia: droppedByCau.size,
      chi_tiet: Array.from(droppedByCau.entries()).map(([so_cau, dropped]) => ({
        so_cau,
        so_dong_bi_drop: dropped.length,
        dong_bi_drop: dropped.map(x => ({
          ly_do: x.reason,
          dong_claude_bia: x.data.dong || '(không có)',
          ghi_chu_claude: x.data.ghi_chu || ''
        }))
      })),
      canh_bao_chung: `Phát hiện AI bịa ${total} dòng không có trong bài làm. Đã loại bỏ.`
    };
  }

  // ── Tính lại điểm từ rubric ──
  recomputeScoresFromRubric(parsed, rubric);

  // ── Preprocess math cho KaTeX ──
  prepareForDisplay(parsed);

  return parsed;
}

// Xóa hướng dẫn sửa (nếu Claude lỡ viết)
function stripForbiddenContent(text) {
  let t = String(text || '').trim();
  t = t.replace(/\b(?:hãy|nên|cần|phải|em\s+nên|em\s+hãy)\s+[^.!?;]*[.!?;]?\s*/gi, '').trim();
  t = t.replace(/^(gợi ý|hướng sửa|cách sửa|hướng dẫn|cách làm đúng|sửa lại)\s*[:\-]?\s*/i, '').trim();
  return t;
}

// Preprocess text cho KaTeX
function prepareForDisplay(result) {
  if (!result || typeof result !== 'object') return result;
  const safeKatex = (v) => {
    if (typeof v !== 'string' || !v) return v;
    try { return textToKatex(v); } catch { return v; }
  };
  (result.cac_cau || []).forEach(cau => {
    (cau.cham_tung_dong || []).forEach(d => {
      d.dong_katex = safeKatex(d.dong);
      d.ghi_chu_katex = safeKatex(d.ghi_chu);
    });
  });
  return result;
}

// Tính điểm từ rubric
function normalizeText(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function deriveTrangThai(diemDat, diemMax, chamTungDong) {
  if (diemMax <= 0) return 'Bỏ trống';
  const soDong = Array.isArray(chamTungDong) ? chamTungDong.length : 0;
  if (soDong === 0 && diemDat === 0) return 'Bỏ trống';
  if (diemDat >= diemMax - 1e-9) return 'Đúng';
  if (diemDat <= 1e-9) return 'Sai';
  return 'Đúng một phần';
}

function recomputeScoresFromRubric(parsed, rubric) {
  const rubricCauList = Array.isArray(rubric.cac_cau) ? rubric.cac_cau : [];
  const aiByKey = new Map();
  for (const cau of parsed.cac_cau || []) {
    aiByKey.set(normalizeText(cau.so_cau), cau);
  }

  const newCacCau = rubricCauList.map(rubricCau => {
    const aiCau = aiByKey.get(normalizeText(rubricCau.so_cau)) || {};
    const rubricCriteria = (Array.isArray(rubricCau.tieu_chi) ? rubricCau.tieu_chi : [])
      .filter(tc => Number(tc.diem || 0) > 0);
    const aiCriteria = Array.isArray(aiCau.diem_tieu_chi) ? aiCau.diem_tieu_chi : [];
    const chamTungDong = Array.isArray(aiCau.cham_tung_dong) ? aiCau.cham_tung_dong : [];
    const diemMax = Number(rubricCau.diem || 0);

    let diemDat = 0;
    let fixedCriteria = [];

    if (rubricCriteria.length > 0) {
      // CÓ tiêu chí → cộng điểm các tiêu chí đạt
      fixedCriteria = rubricCriteria.map((tc, idx) => {
        const ai = aiCriteria.find(a => {
          const aIdx = typeof a?.tieu_chi_index === 'number' ? a.tieu_chi_index : parseInt(a?.tieu_chi_index);
          return aIdx === idx;
        });
        const dat = ai?.dat === true;
        return {
          tieu_chi: tc.mo_ta,
          dat,
          diem: dat ? Number(tc.diem || 0) : 0,
          diem_toi_da: Number(tc.diem || 0)
        };
      });
      diemDat = fixedCriteria.reduce((s, tc) => s + Number(tc.diem || 0), 0);
    } else {
      // KHÔNG có tiêu chí → chấm theo tỉ lệ dòng đúng
      if (chamTungDong.length === 0) {
        diemDat = 0;
      } else {
        const soSai = chamTungDong.filter(d => String(d.ket_qua || '').includes('✗')).length;
        if (soSai === 0) {
          diemDat = diemMax;
        } else {
          const soDung = chamTungDong.length - soSai;
          diemDat = (soDung / chamTungDong.length) * diemMax;
        }
      }
    }

    const trangThai = aiCau.trang_thai || deriveTrangThai(diemDat, diemMax, chamTungDong);

    return {
      so_cau: rubricCau.so_cau,
      diem_dat: Math.round(diemDat * 100) / 100,
      diem_toi_da: diemMax,
      trang_thai: trangThai,
      cham_tung_dong: chamTungDong,
      diem_tieu_chi: fixedCriteria
    };
  });

  parsed.cac_cau = newCacCau;

  const tong = newCacCau.reduce((s, c) => s + Number(c.diem_dat || 0), 0);
  parsed.tong_diem = Math.round(tong * 100) / 100;
  parsed.diem_toi_da = Number(rubric.tong_diem || 0);
  parsed.phan_tram = parsed.diem_toi_da > 0
    ? Math.round((parsed.tong_diem / parsed.diem_toi_da) * 1000) / 10 : 0;
  const pct = parsed.phan_tram;
  parsed.xep_loai = pct >= 80 ? 'Giỏi' : pct >= 65 ? 'Khá' : pct >= 50 ? 'Trung bình' : 'Yếu';
  return parsed;
}

// Repair JSON bị cắt / thiếu đóng ngoặc
function repairJson(str) {
  let s = String(str || '').trim();
  if (!s) return s;
  s = s.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  let stack = [], inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if ((c === '}' || c === ']') && stack.length) stack.pop();
  }
  s = s.replace(/,\s*$/, '');
  if (stack.length) s += stack.reverse().join('');
  return s;
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

router.post('/', uploadMiddleware, async (req, res) => {
  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    if (!rubricStr) return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });
    let rubric;
    try { rubric = JSON.parse(rubricStr); }
    catch { return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' }); }
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY' });

    console.log(`[${studentName}] OCR...`);
    const t0 = Date.now();
    const transcribed = await transcribeWithGemini(req.files, subject);
    console.log(`[${studentName}] OCR xong (${Date.now() - t0}ms). Chấm...`);

    const t1 = Date.now();
    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);
    console.log(`[${studentName}] Chấm xong (${Date.now() - t1}ms): ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`);

    const resultId = uuidv4();
    const resultData = {
      id: resultId, studentName, subject, gradingResult, transcribed,
      imageFiles: req.files.map(f => f.filename), rubric,
      createdAt: new Date().toISOString()
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

router.post('/transcribe', uploadMiddleware, async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    const { subject = 'Toán' } = req.body;
    const transcribed = await transcribeWithGemini(req.files, subject);
    const sessionId = uuidv4();
    const sessionsDir = path.join(__dirname, '../results/sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
      sessionId, imageFiles: req.files.map(f => f.filename),
      transcribed, createdAt: new Date().toISOString()
    }, null, 2));
    res.json({ success: true, sessionId, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

router.get('/:id', (req, res) => {
  const fp = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

router.get('/', (req, res) => {
  const dir = path.join(__dirname, '../results');
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return {
      id: d.id, studentName: d.studentName, subject: d.subject,
      tongDiem: d.gradingResult?.tong_diem, diemToiDa: d.gradingResult?.diem_toi_da,
      createdAt: d.createdAt
    };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;

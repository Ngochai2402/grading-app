// ─────────────────────────────────────────────────────────────────────────────
// grade.js — v4: chấm theo tiêu chí (bỏ logic tỉ lệ dòng)
//
// Thay đổi chính so với v3:
//   1. BỎ HOÀN TOÀN nhánh "tính điểm theo tỉ lệ dòng đúng/sai" khi không có
//      tiêu chí. Mọi câu đều chấm qua tiêu chí.
//   2. Nếu rubric câu thiếu tiêu chí → Claude auto-tách tiêu chí tối thiểu từ
//      noi_dung + dap_an + diem. Chỉ lưu vào kết quả bài đó, KHÔNG ghi đè
//      rubric gốc. Gắn cờ "tieu_chi_auto_tach: true" cho thầy biết.
//   3. Claude trả thêm "do_tin_cay" (0-1) cho mỗi câu.
//   4. Backend đặt "can_giao_vien_xem: true" khi do_tin_cay < 0.7 hoặc có dấu
//      hiệu OCR mơ hồ (nhiều [?] trong dòng).
//   5. Prompt chấm: đối chiếu ý/bước, không đối chiếu dòng.
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

// Ngưỡng confidence: dưới ngưỡng này → cần giáo viên xem
const CONFIDENCE_THRESHOLD = 0.7;

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
// GIAI ĐOẠN 1.5: Auto-tách tiêu chí (Claude Haiku) cho câu thiếu
// ════════════════════════════════════════════════════════════════
async function autoSplitCriteriaForCau(cau, subject) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Bạn là giáo viên ${subject} chuyên nghiệp. Nhiệm vụ: tách một câu hỏi thành các tiêu chí chấm điểm tối thiểu.

=== CÂU CẦN TÁCH TIÊU CHÍ ===
- Số câu: ${cau.so_cau}
- Nội dung: ${cau.noi_dung || '(không có)'}
- Đáp án chuẩn: ${cau.dap_an || '(không có)'}
- Điểm tối đa: ${cau.diem}

=== NGUYÊN TẮC TÁCH ===
1. Tách thành 2-5 tiêu chí cơ bản, mỗi tiêu chí rõ ràng, có thể đánh giá được.
2. Tổng điểm các tiêu chí phải BẰNG ${cau.diem} (chia đều hoặc theo trọng số phù hợp).
3. Theo dạng câu:
   - Câu "Tính/Tìm..." → lập biểu thức/phương trình + tính ra kết quả + kết luận
   - Câu "Giải phương trình..." → biến đổi + tìm nghiệm + kết luận
   - Câu "Chứng minh..." → lý luận + từng bước suy luận + kết luận
   - Câu "Rút gọn..." → biến đổi + kết quả rút gọn đúng
   - Câu "Giải bài toán..." → đặt ẩn/điều kiện + lập PT + giải + kết luận
   - Câu "Lập bảng/Vẽ đồ thị..." → bảng giá trị + vẽ đồ thị đúng
4. Tiêu chí nào là "kết quả cuối cùng" PHẢI có điểm lớn nhất (thường 50-60% điểm câu).

Trả về JSON thuần (không markdown, không text khác):
{
  "tieu_chi": [
    { "mo_ta": "Mô tả tiêu chí ngắn gọn", "diem": 0.25 }
  ]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = response.content?.[0]?.text || '';
    const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/({[\s\S]*})/);
    const parsed = JSON.parse(repairJson(m ? m[1] : raw));

    // Validate: tổng điểm tiêu chí phải bằng cau.diem (cho phép sai số 0.01)
    const tong = (parsed.tieu_chi || []).reduce((s, tc) => s + Number(tc.diem || 0), 0);
    if (Math.abs(tong - Number(cau.diem)) > 0.01) {
      // Re-scale nếu lệch
      const factor = Number(cau.diem) / tong;
      parsed.tieu_chi.forEach(tc => {
        tc.diem = Math.round(Number(tc.diem) * factor * 100) / 100;
      });
    }

    return parsed.tieu_chi || [];
  } catch (err) {
    console.warn(`[auto-tách] Câu ${cau.so_cau} thất bại: ${err.message}. Dùng fallback.`);
    // Fallback: tách cơ học thành 2 tiêu chí
    return [
      { mo_ta: 'Trình bày bài làm hợp lý', diem: Math.round(cau.diem * 0.4 * 100) / 100 },
      { mo_ta: 'Kết quả/kết luận đúng', diem: Math.round(cau.diem * 0.6 * 100) / 100 }
    ];
  }
}

// Chuẩn bị rubric cho việc chấm: auto-tách tiêu chí cho câu thiếu.
// Trả về rubric mới (không đụng rubric gốc) + cờ cau.tieu_chi_auto_tach.
async function prepareRubricForGrading(rubric, subject) {
  const newRubric = JSON.parse(JSON.stringify(rubric)); // deep clone
  const cauCanTach = (newRubric.cac_cau || []).filter(cau => {
    const tcValid = (cau.tieu_chi || []).filter(tc => Number(tc.diem || 0) > 0);
    return tcValid.length === 0 && Number(cau.diem || 0) > 0;
  });

  if (cauCanTach.length === 0) return newRubric;

  console.log(`[auto-tách] ${cauCanTach.length} câu thiếu tiêu chí, đang tách...`);
  // Chạy song song (Haiku nhanh, không lo rate limit cho vài câu)
  await Promise.all(cauCanTach.map(async cau => {
    cau.tieu_chi = await autoSplitCriteriaForCau(cau, subject);
    cau.tieu_chi_auto_tach = true; // cờ để UI biết
  }));

  return newRubric;
}

// ════════════════════════════════════════════════════════════════
// GIAI ĐOẠN 2: Claude chấm — theo tiêu chí, không theo dòng
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

  // Build rubric: liệt kê tiêu chí CÓ ĐIỂM cho từng câu
  const rubricSpec = (rubric.cac_cau || []).map(cau => {
    const tcList = (cau.tieu_chi || [])
      .filter(tc => Number(tc.diem || 0) > 0)
      .map((tc, idx) => `    [TC${idx}] "${tc.mo_ta}" — ${tc.diem}đ`)
      .join('\n');
    return `• ${cau.so_cau} (tối đa ${cau.diem}đ):
  Đề: ${cau.noi_dung || '(không có)'}
  Đáp án chuẩn: ${cau.dap_an || '(không có)'}
  Tiêu chí:
${tcList || '    (Câu này không có tiêu chí chi tiết — chấm theo đáp án chuẩn)'}`;
  }).join('\n\n');

  const rubricCauList = (rubric.cac_cau || []).map(c => c.so_cau).join(', ');
  const lastIdx = Math.max(indexedLines.length - 1, 0);

  const prompt = `Bạn là GIÁO VIÊN ${subject} đang chấm bài học sinh ${studentName}. Chấm bằng cách đối chiếu bài làm với ĐÁP ÁN CHUẨN và TIÊU CHÍ trong rubric.

=== BÀI LÀM HỌC SINH (mỗi dòng có [n] ở đầu) ===
${indexedText || '(Học sinh không viết gì)'}

=== RUBRIC CHÍNH THỨC ===
${rubricSpec}

Số câu cần chấm: ${(rubric.cac_cau || []).length} — ${rubricCauList}

=== NGUYÊN TẮC CHẤM ===

A. TƯ DUY CHẤM (quan trọng nhất):
Bạn là GIÁO VIÊN ĐANG ĐỐI CHIẾU BÀI LÀM VỚI ĐÁP ÁN để quyết định từng tiêu chí đạt/chưa đạt.
- Đọc kỹ "Đáp án chuẩn" của từng câu. Đây là SỰ THẬT.
- Với mỗi TIÊU CHÍ, xác định: học sinh có đáp ứng tiêu chí đó không?
  · Tiêu chí về kết quả → chỉ cần kết quả HS khớp đáp án chuẩn → đạt (dù HS ghi nhầm số liệu trung gian, VD viết "25% × 500 = 75" khi tổng là 300 — kết quả 75 đúng thì vẫn đạt tiêu chí "tính đúng số A").
  · Tiêu chí về quá trình/biến đổi → HS phải có bước trình bày rõ ràng, không sai toán học cơ bản.
  · Tiêu chí về kết luận → HS phải có câu kết luận hoặc ghi rõ đáp số.
- KHÔNG tự tính toán theo đề bài để bắt bẻ HS. Chỉ đối chiếu với đáp án chuẩn.
- Nếu HS làm cách khác nhưng đúng toán học và ra đúng kết quả → tiêu chí vẫn đạt.

B. THAM CHIẾU DÒNG (bắt buộc):
- MỖI entry trong "cham_tung_dong" phải có "dong_index" là SỐ NGUYÊN từ 0 đến ${lastIdx}.
- TUYỆT ĐỐI KHÔNG viết lại nội dung dòng — CHỈ điền số index.
- Không dùng lại cùng 1 dong_index trong cùng 1 câu.
- Entry không có dong_index hợp lệ sẽ bị backend LOẠI BỎ.

C. CHẤM TỪNG DÒNG:
- "ket_qua" = "✓" hoặc "✗" (CHỈ 2 ký tự).
- Dòng ĐÚNG → "ghi_chu" = "" (RỖNG).
- Dòng SAI → "ghi_chu" = 1 cụm CỰC NGẮN chỉ chỗ sai (≤ 10 từ). VD: "Sai dấu", "Kết quả sai", "Nhầm công thức Vi-ét".
- CẤM hướng dẫn sửa ("Hãy...", "Nên...", "Cần...", "đúng phải là...", "lẽ ra..."), CẤM giải thích dài.
- Đưa MỌI dòng HS viết vào cham_tung_dong để thầy thấy đầy đủ.

D. CHẤM TIÊU CHÍ (quyết định điểm):
- Với MỖI câu, trả về "diem_tieu_chi" đủ tất cả tiêu chí trong rubric theo ĐÚNG thứ tự.
- Mỗi phần tử: { "tieu_chi_index": <số TC>, "dat": true|false }
- "dat" = true CHỈ KHI có bằng chứng rõ ràng HS đáp ứng tiêu chí. Không rõ → false.

E. ĐỘ TIN CẬY (bắt buộc cho mỗi câu):
- "do_tin_cay" ∈ [0.0, 1.0]: mức độ tin tưởng vào kết quả chấm câu này.
- 1.0 = rất chắc chắn (bài làm rõ ràng, đầy đủ, khớp đáp án).
- 0.7 = tương đối chắc (có vài dòng mờ nhưng kết luận rõ).
- 0.5 = không chắc (OCR nhiều [?], thiếu dòng, khó phân câu, HS làm cách lạ).
- 0.0-0.4 = rất không chắc (quá mờ, không đủ bằng chứng).
- HS bỏ trống câu → do_tin_cay = 1.0 (chắc chắn là bỏ trống).

F. TRẠNG THÁI:
- "trang_thai" ∈ { "Đúng", "Đúng một phần", "Sai", "Bỏ trống" }.
- HS bỏ trống câu → trang_thai = "Bỏ trống", cham_tung_dong = [], diem_tieu_chi tất cả dat=false.

G. PHẢI CHẤM ĐỦ ${(rubric.cac_cau || []).length} CÂU: ${rubricCauList}.

Trả về JSON thuần (không markdown, không text khác):
{
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "trang_thai": "Đúng một phần",
      "do_tin_cay": 0.85,
      "cham_tung_dong": [
        { "dong_index": 0, "ket_qua": "✓", "ghi_chu": "" },
        { "dong_index": 1, "ket_qua": "✗", "ghi_chu": "Sai dấu" }
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

      d.dong = indexedLines[idx].dong;
      delete d.dong_index;

      const kq = String(d.ket_qua || '').trim();
      d.ket_qua = (kq.includes('✓') || kq.toLowerCase().includes('đúng')) ? '✓' : '✗';

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

  // ── Tính lại điểm từ rubric (THUẦN tiêu chí, không còn tỉ lệ dòng) ──
  recomputeScoresFromRubric(parsed, rubric);

  // ── Đặt cờ can_giao_vien_xem ──
  markCauCanReview(parsed, transcribed);

  // ── Preprocess math cho KaTeX ──
  prepareForDisplay(parsed);

  return parsed;
}

// Xóa hướng dẫn sửa + cắt ghi chú dài
function stripForbiddenContent(text) {
  let t = String(text || '').trim();
  t = t.replace(/\b(?:hãy|nên|cần|phải|em\s+nên|em\s+hãy|lẽ\s+ra|đ[uú]ng\s+ph[aả]i\s+l[aà]|c[aá]ch\s+s[uử]a)\s+[^.!?;]*[.!?;]?\s*/gi, '').trim();
  t = t.replace(/^(gợi ý|hướng sửa|cách sửa|hướng dẫn|cách làm đúng|sửa lại|ghi nh[aầ]m)\s*[:\-]?\s*/i, '').trim();
  t = t.replace(/^[,;:.\s]+/, '').replace(/[,;]\s*$/, '').trim();
  if (t.length > 80) {
    const firstSent = t.slice(0, 80).match(/^[^.;:]{1,80}/);
    t = (firstSent ? firstSent[0] : t.slice(0, 80)).trim();
  }
  return t;
}

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

// ════════════════════════════════════════════════════════════════
// Tính điểm THUẦN theo tiêu chí — không còn nhánh "tỉ lệ dòng"
// ════════════════════════════════════════════════════════════════
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
      // KHÔNG có tiêu chí — điều này không nên xảy ra sau prepareRubricForGrading.
      // Fallback an toàn: nếu HS có cham_tung_dong và không có dòng ✗ → full điểm,
      // có dòng ✗ → 0 điểm, bỏ trống → 0 điểm.
      if (chamTungDong.length === 0) {
        diemDat = 0;
      } else {
        const hasSai = chamTungDong.some(d => String(d.ket_qua || '').includes('✗'));
        diemDat = hasSai ? 0 : diemMax;
      }
    }

    const trangThai = aiCau.trang_thai || deriveTrangThai(diemDat, diemMax, chamTungDong);
    const doTinCay = typeof aiCau.do_tin_cay === 'number' ? Math.max(0, Math.min(1, aiCau.do_tin_cay)) : 0.8;

    return {
      so_cau: rubricCau.so_cau,
      diem_dat: Math.round(diemDat * 100) / 100,
      diem_toi_da: diemMax,
      trang_thai: trangThai,
      do_tin_cay: Math.round(doTinCay * 100) / 100,
      tieu_chi_auto_tach: rubricCau.tieu_chi_auto_tach === true,
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

// ════════════════════════════════════════════════════════════════
// Đặt cờ can_giao_vien_xem cho câu có confidence thấp / OCR mờ
// ════════════════════════════════════════════════════════════════
function markCauCanReview(parsed, transcribed) {
  // Map OCR theo so_cau để check dấu [?]
  const ocrByKey = new Map();
  (transcribed.cac_cau || []).forEach(cau => {
    ocrByKey.set(normalizeText(cau.so_cau), cau.noi_dung_goc || []);
  });

  let soCauCanXem = 0;
  const lyDoTongHop = new Set();

  (parsed.cac_cau || []).forEach(cau => {
    const reasons = [];

    // Lý do 1: confidence thấp
    if (cau.do_tin_cay < CONFIDENCE_THRESHOLD) {
      reasons.push(`Độ tin cậy thấp (${Math.round(cau.do_tin_cay * 100)}%)`);
    }

    // Lý do 2: OCR nhiều [?]
    const ocrLines = ocrByKey.get(normalizeText(cau.so_cau)) || [];
    const totalChars = ocrLines.join('').length;
    const questionMarks = (ocrLines.join('').match(/\[\?\]/g) || []).length;
    if (questionMarks >= 3 || (totalChars > 0 && questionMarks / Math.max(totalChars / 20, 1) > 0.5)) {
      reasons.push(`OCR mờ (${questionMarks} ký tự không đọc được)`);
    }

    // Lý do 3: tiêu chí tự tách (thầy nên duyệt)
    if (cau.tieu_chi_auto_tach) {
      reasons.push('Tiêu chí do AI tự tách');
    }

    // Lý do 4: status lẫn lộn — có dòng sai nhưng tất cả tiêu chí đều đạt, hoặc ngược lại
    const hasSai = (cau.cham_tung_dong || []).some(d => d.ket_qua === '✗');
    const allCriteriaPass = (cau.diem_tieu_chi || []).length > 0
      && (cau.diem_tieu_chi || []).every(tc => tc.dat === true);
    if (hasSai && allCriteriaPass && cau.trang_thai === 'Đúng') {
      reasons.push('Có dòng sai nhưng mọi tiêu chí đạt');
    }

    if (reasons.length > 0) {
      cau.can_giao_vien_xem = true;
      cau.ly_do_can_xem = reasons;
      soCauCanXem++;
      reasons.forEach(r => lyDoTongHop.add(r.split(' (')[0]));
    } else {
      cau.can_giao_vien_xem = false;
    }
  });

  if (soCauCanXem > 0) {
    parsed.tom_tat_review = {
      so_cau_can_xem: soCauCanXem,
      tong_so_cau: (parsed.cac_cau || []).length,
      ly_do_chinh: Array.from(lyDoTongHop)
    };
  }
}

// ════════════════════════════════════════════════════════════════
// Repair JSON bị cắt / thiếu đóng ngoặc
// ════════════════════════════════════════════════════════════════
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
    console.log(`[${studentName}] OCR xong (${Date.now() - t0}ms).`);

    console.log(`[${studentName}] Auto-tách tiêu chí (nếu cần)...`);
    const t1 = Date.now();
    const rubricPrepared = await prepareRubricForGrading(rubric, subject);
    console.log(`[${studentName}] Rubric sẵn sàng (${Date.now() - t1}ms).`);

    console.log(`[${studentName}] Chấm...`);
    const t2 = Date.now();
    const gradingResult = await gradeWithClaude(transcribed, rubricPrepared, studentName, subject);
    console.log(`[${studentName}] Chấm xong (${Date.now() - t2}ms): ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`);

    const resultId = uuidv4();
    const resultData = {
      id: resultId, studentName, subject, gradingResult, transcribed,
      imageFiles: req.files.map(f => f.filename),
      rubric: rubricPrepared, // lưu rubric đã được auto-tách (nếu có)
      rubric_goc: rubric,     // giữ bản gốc để tham khảo
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

    const rubricPrepared = await prepareRubricForGrading(rubric, subject);
    const gradingResult = await gradeWithClaude(transcribed, rubricPrepared, studentName, subject);
    let imageFiles = [];
    if (sessionId) {
      const sp = path.join(__dirname, '../results/sessions', `${sessionId}.json`);
      if (fs.existsSync(sp)) imageFiles = JSON.parse(fs.readFileSync(sp, 'utf8')).imageFiles;
    }
    const resultId = uuidv4();
    const resultData = {
      id: resultId, studentName, subject, gradingResult, transcribed, imageFiles,
      rubric: rubricPrepared, rubric_goc: rubric,
      createdAt: new Date().toISOString()
    };
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
      soCauCanXem: d.gradingResult?.tom_tat_review?.so_cau_can_xem || 0,
      createdAt: d.createdAt
    };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;

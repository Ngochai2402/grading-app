// ─────────────────────────────────────────────────────────────────────────────
// verify.js — Module bảo vệ tính toàn vẹn của bài làm học sinh
//
// MỤC ĐÍCH: Phát hiện khi AI (Claude) TỰ SỬA nội dung học sinh viết.
// Ví dụ: học sinh viết "Δ = 20" (sai), nếu Claude trả "Δ = 92" (tự tính lại)
// trong trường `dong` của `cham_tung_dong` → đây là VI PHẠM nghiêm trọng.
//
// Hàm verifyIntegrity:
//   - Lấy tất cả dòng gốc từ OCR (noi_dung_goc)
//   - So sánh với từng dòng Claude trả về (dong trong cham_tung_dong)
//   - Nếu dòng Claude trả về KHÔNG MATCH với bất kỳ dòng OCR nào → VI PHẠM
//   - Tự động THAY THẾ dòng bị sửa bằng dòng OCR gốc gần nhất
//   - Ghi cảnh báo để giáo viên biết
// ─────────────────────────────────────────────────────────────────────────────

// Normalize để so sánh: bỏ whitespace, dấu câu không quan trọng, chuẩn hóa dấu tiếng Việt
function normalizeForCompare(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFC')
    .replace(/\s+/g, '')        // bỏ toàn bộ whitespace
    .replace(/[·•\*]/g, '')     // bỏ dấu nhân trang trí
    .replace(/[""]/g, '"')      // chuẩn hóa quote
    .replace(/['']/g, "'")      // chuẩn hóa apostrophe
    .replace(/[–—]/g, '-')      // chuẩn hóa gạch ngang
    .toLowerCase();
}

// Chuẩn hóa KÝ HIỆU TOÁN: giữ lại tất cả số, biến, toán tử, CHỈ SỐ Unicode để so sánh nghiêm ngặt
// Mục đích: phát hiện nếu Claude đổi số 20 → 92, đổi dấu +, đổi căn, BỎ CHỈ SỐ x₁ → x, v.v.
function extractMathSignature(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFC')
    // Giữ:
    //   - số (0-9), chữ cái La-tinh (a-z, A-Z) — biến
    //   - toán tử cơ bản: + - * / = < > ( ) [ ] { } ^ _ $ | , .
    //   - ký hiệu Hy Lạp và toán học
    //   - CHỈ SỐ DƯỚI Unicode: ₀-₉ (U+2080-U+2089), ₊₋₌₍₎
    //   - CHỈ SỐ TRÊN Unicode: ⁰-⁹ (U+2070-U+2079), ⁺⁻⁼⁽⁾
    //   - Các ký hiệu: ⊥ ∥ ∽ △ ∠ ⌢ ≈ ≠ ≤ ≥ π Δ √ ± ∓ ∞ ⇒ ⇔ → ← ↔ ∈ ∉ ⊂ ⊆ ∪ ∩ ∅
    //   - Chữ Hy Lạp: α β γ δ ε ζ η θ λ μ ν ξ ρ σ τ φ χ ψ ω
    .replace(/[^0-9a-zA-Z₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ΔδπθλμνξρστφχψωαβγεζηΛΣΠΘΦΨΩ√∞±∓≈≠≤≥⊥∥∽△∠⌢⇒⇔→←↔∈∉⊂⊆∪∩∅ℝℕℤℚ+\-*/=<>().,\[\]{}^_$|]/g, '')
    .toLowerCase();
}

// Levenshtein distance để match fuzzy (trường hợp OCR có thêm/bớt vài ký tự)
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  
  // Tối ưu memory: chỉ lưu 2 hàng
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insert
        prev[j] + 1,           // delete
        prev[j - 1] + cost     // replace
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Similarity 0-1 dựa trên Levenshtein
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Tìm dòng OCR gốc khớp nhất với dòng Claude trả về
function findBestMatch(claudeLine, ocrLines) {
  const claudeNorm = normalizeForCompare(claudeLine);
  const claudeMath = extractMathSignature(claudeLine);
  
  if (!claudeNorm) return null;
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const ocrLine of ocrLines) {
    const ocrNorm = normalizeForCompare(ocrLine);
    const ocrMath = extractMathSignature(ocrLine);
    
    if (!ocrNorm) continue;
    
    // Điểm tổng hợp: 60% similarity text + 40% similarity math signature
    const textSim = similarity(claudeNorm, ocrNorm);
    const mathSim = similarity(claudeMath, ocrMath);
    const combinedScore = textSim * 0.6 + mathSim * 0.4;
    
    if (combinedScore > bestScore) {
      bestScore = combinedScore;
      bestMatch = { ocrLine, textSim, mathSim, combinedScore };
    }
  }
  
  return bestMatch;
}

// Kiểm tra xem 2 dòng có "giống đủ" không
// Ngưỡng: >= 0.85 combined score VÀ math signature >= 0.90
// Math signature phải rất cao vì đây là yếu tố CHÍNH phát hiện AI sửa số
function isAcceptableMatch(match) {
  if (!match) return false;
  return match.combinedScore >= 0.85 && match.mathSim >= 0.90;
}

// ─────────────────────────────────────────────────────────────────────────────
// HÀM CHÍNH: verifyIntegrity
// Input:  gradingResult (từ Claude), transcribed (từ Gemini OCR)
// Output: { gradingResult đã sửa, violations: [...], stats: {...} }
// ─────────────────────────────────────────────────────────────────────────────
function verifyIntegrity(gradingResult, transcribed) {
  const violations = [];
  let totalLines = 0;
  let violationCount = 0;
  let autoFixedCount = 0;
  
  if (!gradingResult?.cac_cau || !transcribed?.cac_cau) {
    return { gradingResult, violations: [], stats: { totalLines: 0, violationCount: 0, autoFixedCount: 0 } };
  }
  
  // Build map: so_cau → list các dòng OCR gốc của câu đó
  const ocrByQuestion = new Map();
  for (const cau of transcribed.cac_cau) {
    const key = String(cau.so_cau || '').trim().toLowerCase();
    ocrByQuestion.set(key, cau.noi_dung_goc || []);
  }
  
  // Build TẤT CẢ các dòng OCR (để fallback nếu không tìm thấy trong cùng câu)
  const allOcrLines = [];
  for (const cau of transcribed.cac_cau) {
    for (const dong of (cau.noi_dung_goc || [])) {
      allOcrLines.push(dong);
    }
  }
  
  // Duyệt từng câu trong kết quả chấm
  for (const cau of gradingResult.cac_cau) {
    if (!cau.cham_tung_dong || !Array.isArray(cau.cham_tung_dong)) continue;
    
    const key = String(cau.so_cau || '').trim().toLowerCase();
    const ocrLinesForThisQuestion = ocrByQuestion.get(key) || [];
    
    // Ưu tiên match trong cùng câu, nếu không có thì match toàn bài
    const searchPool = ocrLinesForThisQuestion.length > 0 ? ocrLinesForThisQuestion : allOcrLines;
    
    for (let i = 0; i < cau.cham_tung_dong.length; i++) {
      const lineCheck = cau.cham_tung_dong[i];
      if (!lineCheck?.dong) continue;
      
      totalLines++;
      
      const match = findBestMatch(lineCheck.dong, searchPool);
      
      if (!isAcceptableMatch(match)) {
        // Thử match toàn bài trước khi kết luận vi phạm
        const globalMatch = findBestMatch(lineCheck.dong, allOcrLines);
        
        if (isAcceptableMatch(globalMatch)) {
          // Match được ở câu khác — có thể Claude gán sai câu, không phải sửa nội dung
          // Giữ nguyên nhưng ghi chú
          continue;
        }
        
        violationCount++;
        
        const violation = {
          so_cau: cau.so_cau,
          dong_ai_tra: lineCheck.dong,
          dong_ocr_goc_gan_nhat: match?.ocrLine || null,
          do_tuong_dong_text: match ? Math.round(match.textSim * 100) / 100 : 0,
          do_tuong_dong_toan: match ? Math.round(match.mathSim * 100) / 100 : 0,
          diem_tong_hop: match ? Math.round(match.combinedScore * 100) / 100 : 0,
          ly_do: 'Dòng Claude trả về không khớp với OCR gốc — nghi ngờ AI tự sửa nội dung'
        };
        
        violations.push(violation);
        
        // AUTO-FIX: nếu tìm được match tương đối (>= 0.60), thay thế bằng OCR gốc
        // Ngưỡng thấp hơn để bảo toàn: thà lấy dòng OCR gần đúng còn hơn để AI bịa
        if (match && match.combinedScore >= 0.60) {
          cau.cham_tung_dong[i].dong_ai_da_sua = lineCheck.dong;  // giữ lại bản AI cho audit
          cau.cham_tung_dong[i].dong = match.ocrLine;             // thay bằng OCR gốc
          cau.cham_tung_dong[i].canh_bao = 'AI đã tự sửa nội dung — đã khôi phục từ OCR gốc';
          autoFixedCount++;
        } else {
          // Không tìm được match nào chấp nhận được — đánh dấu NGHI NGỜ
          cau.cham_tung_dong[i].canh_bao = 'Không tìm thấy dòng này trong OCR gốc — cần giáo viên review';
          cau.cham_tung_dong[i].can_review_thu_cong = true;
        }
      }
    }
  }
  
  // Gắn kết quả kiểm tra vào gradingResult
  const stats = { totalLines, violationCount, autoFixedCount };
  
  if (violations.length > 0) {
    gradingResult.kiem_tra_toan_ven = {
      co_vi_pham: true,
      so_dong_vi_pham: violationCount,
      so_dong_tu_dong_sua: autoFixedCount,
      tong_so_dong: totalLines,
      chi_tiet: violations,
      canh_bao_chung: `⚠️ Phát hiện ${violationCount}/${totalLines} dòng có dấu hiệu AI tự sửa nội dung. Đã tự động khôi phục ${autoFixedCount} dòng từ OCR gốc. Vui lòng kiểm tra lại.`
    };
  } else {
    gradingResult.kiem_tra_toan_ven = {
      co_vi_pham: false,
      so_dong_vi_pham: 0,
      so_dong_tu_dong_sua: 0,
      tong_so_dong: totalLines,
      canh_bao_chung: `✓ Đã kiểm tra ${totalLines} dòng — không phát hiện AI tự sửa nội dung.`
    };
  }
  
  return { gradingResult, violations, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// SO SÁNH 2 KẾT QUẢ OCR (Double-OCR consensus)
// Input: 2 transcribed objects từ 2 lần gọi Gemini
// Output: merged transcribed + danh sách dòng lệch (nghi ngờ OCR sai)
// ─────────────────────────────────────────────────────────────────────────────
function mergeDoubleOcr(ocr1, ocr2) {
  const result = {
    cac_cau: [],
    canh_bao_ocr: [],
    thong_ke: { tong_dong: 0, dong_khop: 0, dong_lech: 0 }
  };
  
  // Map câu của OCR2 theo so_cau
  const ocr2Map = new Map();
  for (const cau of ocr2?.cac_cau || []) {
    ocr2Map.set(String(cau.so_cau || '').trim().toLowerCase(), cau);
  }
  
  for (const cau1 of ocr1?.cac_cau || []) {
    const key = String(cau1.so_cau || '').trim().toLowerCase();
    const cau2 = ocr2Map.get(key);
    
    const mergedCau = {
      so_cau: cau1.so_cau,
      noi_dung_goc: [],
      noi_dung_goc_alt: [],  // phiên bản OCR 2 để tham khảo
      do_tin_cay: []          // 'cao' | 'trung_binh' | 'thap'
    };
    
    const lines1 = cau1.noi_dung_goc || [];
    const lines2 = cau2?.noi_dung_goc || [];
    const maxLen = Math.max(lines1.length, lines2.length);
    
    for (let i = 0; i < maxLen; i++) {
      const l1 = lines1[i] || '';
      const l2 = lines2[i] || '';
      
      result.thong_ke.tong_dong++;
      
      if (!l1 && !l2) continue;
      
      if (!l2) {
        // OCR2 thiếu dòng này → tin OCR1 nhưng đánh dấu
        mergedCau.noi_dung_goc.push(l1);
        mergedCau.noi_dung_goc_alt.push('');
        mergedCau.do_tin_cay.push('thap');
        result.thong_ke.dong_lech++;
        result.canh_bao_ocr.push({
          so_cau: cau1.so_cau,
          dong_index: i,
          ly_do: 'OCR lần 2 không đọc được dòng này'
        });
        continue;
      }
      
      if (!l1) {
        mergedCau.noi_dung_goc.push(l2);
        mergedCau.noi_dung_goc_alt.push('');
        mergedCau.do_tin_cay.push('thap');
        result.thong_ke.dong_lech++;
        continue;
      }
      
      // So sánh 2 phiên bản
      const mathSig1 = extractMathSignature(l1);
      const mathSig2 = extractMathSignature(l2);
      const mathSim = similarity(mathSig1, mathSig2);
      const textSim = similarity(normalizeForCompare(l1), normalizeForCompare(l2));
      
      if (mathSim >= 0.95 && textSim >= 0.90) {
        // Khớp cao — tin tuyệt đối
        mergedCau.noi_dung_goc.push(l1);
        mergedCau.noi_dung_goc_alt.push(l2);
        mergedCau.do_tin_cay.push('cao');
        result.thong_ke.dong_khop++;
      } else if (mathSim >= 0.90) {
        // Khớp khá — tin nhưng ghi chú
        mergedCau.noi_dung_goc.push(l1);
        mergedCau.noi_dung_goc_alt.push(l2);
        mergedCau.do_tin_cay.push('trung_binh');
        result.thong_ke.dong_khop++;
      } else {
        // LỆCH — đây là dòng nghi ngờ, CẦN REVIEW
        // Chiến lược: chọn phiên bản DÀI hơn (thường đầy đủ hơn) làm chính
        // vì OCR bỏ ký tự thường do không nhận ra được
        const chosen = l1.length >= l2.length ? l1 : l2;
        const other = l1.length >= l2.length ? l2 : l1;
        mergedCau.noi_dung_goc.push(chosen);
        mergedCau.noi_dung_goc_alt.push(other);
        mergedCau.do_tin_cay.push('thap');
        result.thong_ke.dong_lech++;
        result.canh_bao_ocr.push({
          so_cau: cau1.so_cau,
          dong_index: i,
          phien_ban_1: l1,
          phien_ban_2: l2,
          do_tuong_dong_toan: Math.round(mathSim * 100) / 100,
          ly_do: 'OCR 2 lần cho kết quả khác nhau — cần Claude + ảnh gốc để quyết định'
        });
      }
    }
    
    result.cac_cau.push(mergedCau);
  }
  
  // Nếu OCR2 có câu mà OCR1 không có
  const ocr1Keys = new Set((ocr1?.cac_cau || []).map(c => String(c.so_cau || '').trim().toLowerCase()));
  for (const cau2 of ocr2?.cac_cau || []) {
    const key = String(cau2.so_cau || '').trim().toLowerCase();
    if (!ocr1Keys.has(key)) {
      result.cac_cau.push({
        so_cau: cau2.so_cau,
        noi_dung_goc: cau2.noi_dung_goc || [],
        noi_dung_goc_alt: [],
        do_tin_cay: new Array((cau2.noi_dung_goc || []).length).fill('thap')
      });
      result.canh_bao_ocr.push({
        so_cau: cau2.so_cau,
        ly_do: 'Chỉ OCR lần 2 đọc được câu này, OCR lần 1 bỏ sót'
      });
    }
  }
  
  return result;
}

module.exports = {
  verifyIntegrity,
  mergeDoubleOcr,
  // export helpers để test
  _internals: {
    normalizeForCompare,
    extractMathSignature,
    similarity,
    findBestMatch,
    isAcceptableMatch
  }
};

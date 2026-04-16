// ─────────────────────────────────────────────────────────────────────────────
// latex-utils.js — Xử lý escape LaTeX an toàn cho Railway XeLaTeX
//
// Vấn đề v1: escLat() escape `\` thành `\textbackslash{}` → phá vỡ mọi công thức
// LaTeX Claude trả về (như `\frac{a}{b}`, `\sqrt{x}`, `\Delta`).
// 
// Giải pháp v2:
//   1. Chuyển ký hiệu Unicode → LaTeX trước (Δ → \Delta, x² → x^2, √21 → \sqrt{21})
//   2. Phát hiện và GIỮ NGUYÊN các lệnh LaTeX hợp lệ (\frac, \sqrt, \Delta...)
//   3. Bọc auto vào $...$ nếu chưa có
//   4. Escape chỉ các ký tự đặc biệt còn lại
// ─────────────────────────────────────────────────────────────────────────────

// Danh sách các lệnh LaTeX hợp lệ mà Claude thường dùng trong chấm bài
// Nếu gặp các lệnh này thì GIỮ NGUYÊN, không escape \
const VALID_LATEX_COMMANDS = new Set([
  // Phân số, căn, lũy thừa
  'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'cbrt',
  // Chỉ số (_ và ^ thường dùng qua dấu)
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak',
  'text', 'textbf', 'textit', 'textnormal', 'textsf', 'texttt', 'emph',
  // Chữ Hy Lạp viết thường
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta',
  'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu',
  'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau',
  'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  // Chữ Hy Lạp viết hoa
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Pi', 'Rho', 'Sigma',
  'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
  // Toán tử và ký hiệu
  'sum', 'prod', 'int', 'oint', 'lim', 'limsup', 'liminf', 'max', 'min',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'exp', 'mod',
  // Quan hệ
  'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'simeq', 'cong',
  'll', 'gg', 'propto', 'parallel', 'perp',
  // Mũi tên
  'to', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow',
  'Leftarrow', 'Leftrightarrow', 'implies', 'iff',
  // Tập hợp
  'in', 'notin', 'subset', 'subseteq', 'supset', 'supseteq',
  'cup', 'cap', 'setminus', 'emptyset', 'varnothing',
  // Hình học
  'angle', 'triangle', 'square', 'cdot', 'times', 'div', 'pm', 'mp',
  'circ', 'bullet', 'ast',
  // Dấu ngoặc / spacing
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'quad', 'qquad', 'hspace', 'vspace',
  // Định dạng khác
  'overline', 'underline', 'widehat', 'widetilde', 'vec', 'bar', 'hat', 'tilde',
  'dot', 'ddot', 'prime',
  // Ký tự đặc biệt khác
  'infty', 'partial', 'nabla', 'forall', 'exists', 'neg', 'land', 'lor',
  'ldots', 'cdots', 'vdots', 'ddots',
  // Môi trường toán
  'begin', 'end',
  // Ký tự thoát hợp lệ trong mode text
  'textbackslash', 'textasciitilde', 'textless', 'textgreater',
  'textasciicircum', '%', '&', '#', '$', '_', '{', '}'
]);

// Map Unicode → LaTeX command (không có backslash)
const UNICODE_TO_LATEX = {
  // Chữ Hy Lạp
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
  'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa',
  'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi',
  'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi',
  'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Α': 'Alpha', 'Β': 'Beta', 'Γ': 'Gamma', 'Δ': 'Delta', 'Ε': 'Epsilon',
  'Ζ': 'Zeta', 'Η': 'Eta', 'Θ': 'Theta', 'Ι': 'Iota', 'Κ': 'Kappa',
  'Λ': 'Lambda', 'Μ': 'Mu', 'Ν': 'Nu', 'Ξ': 'Xi', 'Π': 'Pi',
  'Ρ': 'Rho', 'Σ': 'Sigma', 'Τ': 'Tau', 'Υ': 'Upsilon', 'Φ': 'Phi',
  'Χ': 'Chi', 'Ψ': 'Psi', 'Ω': 'Omega',
  // Tam giác (Claude và học sinh hay viết Δ cho delta và △ cho tam giác)
  '△': 'triangle',
  // Quan hệ
  '≤': 'leq', '≥': 'geq', '≠': 'neq', '≈': 'approx',
  '≡': 'equiv', '∼': 'sim',
  // Mũi tên
  '→': 'to', '←': 'leftarrow', '↔': 'leftrightarrow',
  '⇒': 'Rightarrow', '⟹': 'Rightarrow',
  '⇐': 'Leftarrow', '⇔': 'Leftrightarrow',
  // Tập hợp
  '∈': 'in', '∉': 'notin',
  '⊂': 'subset', '⊆': 'subseteq', '⊃': 'supset', '⊇': 'supseteq',
  '∪': 'cup', '∩': 'cap', '∅': 'emptyset',
  // Toán tử
  '±': 'pm', '∓': 'mp', '×': 'times', '÷': 'div',
  '·': 'cdot', '∙': 'cdot',
  '∞': 'infty', '∂': 'partial', '∇': 'nabla',
  '∀': 'forall', '∃': 'exists',
  '∑': 'sum', '∏': 'prod', '∫': 'int',
  // Hình học
  '∠': 'angle', '⊥': 'perp', '∥': 'parallel',
  '∽': 'sim',  // đồng dạng — dùng sim cho gọn
  '⌢': 'frown',
  // Dấu chấm
  '…': 'ldots', '⋯': 'cdots', '⋮': 'vdots', '⋱': 'ddots'
};

// Subscript/superscript Unicode → LaTeX
const SUBSCRIPT_MAP = {
  '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9',
  '₊':'+','₋':'-','₌':'=','₍':'(','₎':')',
  'ₐ':'a','ₑ':'e','ₒ':'o','ₓ':'x','ₕ':'h','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t'
};

const SUPERSCRIPT_MAP = {
  '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
  '⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')',
  'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ʰ':'h','ⁱ':'i','ʲ':'j',
  'ᵏ':'k','ˡ':'l','ᵐ':'m','ⁿ':'n','ᵒ':'o','ᵖ':'p','ʳ':'r','ˢ':'s','ᵗ':'t','ᵘ':'u',
  'ᵛ':'v','ʷ':'w','ˣ':'x','ʸ':'y','ᶻ':'z'
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Normalize Unicode → LaTeX (bên trong math mode)
// ─────────────────────────────────────────────────────────────────────────────
function unicodeToMathMode(text) {
  if (!text) return '';
  let result = '';
  let i = 0;
  
  while (i < text.length) {
    const ch = text[i];
    
    // Xử lý căn số: √21 → \sqrt{21}, √2 → \sqrt{2}, √{abc} → \sqrt{abc}, √Δ → \sqrt{\Delta}
    if (ch === '√') {
      // Thử đọc { ... }
      if (text[i+1] === '{') {
        let depth = 1, j = i + 2, content = '';
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') { depth--; if (depth === 0) break; }
          content += text[j];
          j++;
        }
        result += `\\sqrt{${content}}`;
        i = j + 1;
        continue;
      }
      // Thử đọc ký tự Hy Lạp hoặc ký hiệu toán Unicode
      if (UNICODE_TO_LATEX[text[i+1]]) {
        result += `\\sqrt{\\${UNICODE_TO_LATEX[text[i+1]]}}`;
        i += 2;
        continue;
      }
      // Đọc số/biến đơn
      let content = '';
      let j = i + 1;
      while (j < text.length && /[0-9a-zA-Z]/.test(text[j])) {
        content += text[j];
        j++;
      }
      if (content) {
        result += `\\sqrt{${content}}`;
        i = j;
      } else {
        // Căn đứng một mình → dùng placeholder
        result += '\\sqrt{\\phantom{x}}';
        i++;
      }
      continue;
    }
    
    // Xử lý chỉ số dưới: x₁ → x_{1}, x₁₀ → x_{10}
    if (SUBSCRIPT_MAP[ch]) {
      let sub = SUBSCRIPT_MAP[ch];
      let j = i + 1;
      while (j < text.length && SUBSCRIPT_MAP[text[j]]) {
        sub += SUBSCRIPT_MAP[text[j]];
        j++;
      }
      result += `_{${sub}}`;
      i = j;
      continue;
    }
    
    // Xử lý chỉ số trên: x² → x^{2}, x²³ → x^{23}
    if (SUPERSCRIPT_MAP[ch]) {
      let sup = SUPERSCRIPT_MAP[ch];
      let j = i + 1;
      while (j < text.length && SUPERSCRIPT_MAP[text[j]]) {
        sup += SUPERSCRIPT_MAP[text[j]];
        j++;
      }
      result += `^{${sup}}`;
      i = j;
      continue;
    }
    
    // Map Unicode → LaTeX command
    if (UNICODE_TO_LATEX[ch]) {
      result += `\\${UNICODE_TO_LATEX[ch]} `;  // thêm space để tránh dính chữ kế tiếp
      i++;
      continue;
    }
    
    // Giữ nguyên ký tự
    result += ch;
    i++;
  }
  
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Sanitize — làm sạch các LaTeX command không hợp lệ
// Ngăn "bet" (thiếu chữ), "mathttt" (dư chữ t), v.v.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeLatexCommands(text) {
  if (!text) return '';
  
  // Sửa command bị viết sai thường gặp
  const commonTypos = [
    [/\\bet(?![a-zA-Z])/g, '\\beta'],     // bet → beta
    [/\\mathttt/g, '\\mathtt'],            // mathttt → mathtt
    [/\\mathht/g, '\\mathrm'],             // mathht → mathrm (lỗi OCR)
    [/\\rac\{/g, '\\frac{'],               // rac → frac (mất chữ f)
    [/\\qrt\{/g, '\\sqrt{'],               // qrt → sqrt (mất chữ s)
  ];
  
  let result = text;
  for (const [pattern, replacement] of commonTypos) {
    result = result.replace(pattern, replacement);
  }
  
  // Loại bỏ các \commandName không có trong danh sách hợp lệ
  // Thay thế bằng plain text (bỏ backslash)
  result = result.replace(/\\([a-zA-Z]+)/g, (match, cmd) => {
    if (VALID_LATEX_COMMANDS.has(cmd)) {
      return match;  // giữ nguyên
    }
    // Command không hợp lệ → biến thành text thường (an toàn)
    console.warn(`[LaTeX sanitize] Unknown command "\\${cmd}" → converted to text`);
    return cmd;
  });
  
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Escape ký tự đặc biệt LaTeX trong text mode
// CHỈ escape các ký tự, KHÔNG escape \command
// ─────────────────────────────────────────────────────────────────────────────
function escapeTextMode(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\/g, '\u0000')       // tạm thay \ bằng placeholder
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/\$/g, '\\$')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\u0000/g, '\\textbackslash{}');  // khôi phục \ thành \textbackslash{}
}

// ─────────────────────────────────────────────────────────────────────────────
// HÀM CHÍNH: chuyển text có lẫn LaTeX và Unicode → LaTeX an toàn
//
// Chiến lược:
// 1. Nếu đã có $...$ hoặc \(...\), coi phần đó là math mode có sẵn
//    → chỉ chuyển Unicode bên trong thành LaTeX, sanitize command
// 2. Bên ngoài $...$, xử lý thông minh:
//    - Nếu có ký tự toán (Δ, √, ², x₁, \frac, \sqrt, v.v.) → bọc vào $...$
//    - Bình thường → escape như text
// ─────────────────────────────────────────────────────────────────────────────

// Kiểm tra text có ký tự toán không
function hasMathContent(text) {
  return /[ΔΣΠΘΛΦΨΩαβγδεζηθλμνπρστφχψω²³⁰-⁹₀-₉√∑∏∫∞≈≠≤≥∈∉⊂⊆∪∩⇒⇔→±×÷·∠⊥∥∽△]/.test(text)
      || /\\(frac|dfrac|sqrt|Delta|alpha|beta|gamma|sum|prod|int)/.test(text);
}

// Phân tách text thành các segment: text mode và math mode
function splitByMathMode(text) {
  if (!text) return [];
  const segments = [];
  
  // Pattern: $...$ hoặc \(...\) hoặc \[...\]
  const mathPattern = /(\$[^$\n]+?\$|\\\([^\n]+?\\\)|\\\[[^\n]+?\\\])/g;
  
  let lastIndex = 0;
  let match;
  while ((match = mathPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    // Lấy phần trong delimiter
    const raw = match[0];
    let inner;
    if (raw.startsWith('$')) {
      inner = raw.slice(1, -1);
    } else if (raw.startsWith('\\(')) {
      inner = raw.slice(2, -2);
    } else {
      inner = raw.slice(2, -2);
    }
    segments.push({ type: 'math', content: inner });
    lastIndex = match.index + raw.length;
  }
  
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }
  
  return segments;
}

// Xử lý 1 segment math: chuyển Unicode → LaTeX, sanitize command
function processMathSegment(content) {
  const converted = unicodeToMathMode(content);
  return sanitizeLatexCommands(converted);
}

// Xử lý 1 segment text: nếu có math char thì tách ra, không thì escape
function processTextSegment(content) {
  if (!hasMathContent(content)) {
    return escapeTextMode(content);
  }
  
  // Có math char trong text → tách thành các phần:
  //  - Phần thuần text (không có math char)
  //  - Phần có math char → bọc $...$
  
  // Regex: ký tự math Unicode/khoảng trắng
  const MATH_CHAR = /[ΔΣΠΘΛΦΨΩαβγδεζηθλμνπρστφχψω²³⁰-⁹₀-₉√∑∏∫∞≈≠≤≥∈∉⊂⊆∪∩⇒⇔→±×÷·∠⊥∥∽△]/;
  // Ký tự có thể là phần của công thức (biến, số, toán tử, ngoặc, dấu phân cách thập phân)
  const MATH_CONTINUE = /[a-zA-Z0-9+\-*/=().,^_!]/;
  // Ký tự cắt ngang công thức RÕ RÀNG (chỉ whitespace + dấu câu kết thúc)
  const MATH_STOP = /[\s;:"'`]/;
  
  const parts = [];
  let current = '';
  let currentType = null;  // 'text' | 'math'
  
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const isMath = MATH_CHAR.test(ch);
    const isMathContinue = MATH_CONTINUE.test(ch);
    const isMathStop = MATH_STOP.test(ch);
    
    if (isMath) {
      if (currentType === 'text') {
        // Nhìn lùi: kéo các ký tự continue liền kề vào math
        let back = 0;
        while (current.length - back > 0 && MATH_CONTINUE.test(current[current.length - 1 - back])) {
          back++;
        }
        if (back > 0) {
          const mathPart = current.slice(-back);
          current = current.slice(0, -back);
          if (current) parts.push({ type: 'text', content: current });
          current = mathPart + ch;
        } else {
          if (current) parts.push({ type: 'text', content: current });
          current = ch;
        }
        currentType = 'math';
      } else {
        current = (current || '') + ch;
        currentType = 'math';
      }
    } else if (isMathStop) {
      // Ký tự cắt chắc chắn → kết thúc math, đẩy sang text
      if (currentType === 'math') {
        parts.push({ type: 'math', content: current });
        current = ch;
        currentType = 'text';
      } else {
        current = (current || '') + ch;
        currentType = currentType || 'text';
      }
    } else if (currentType === 'math' && isMathContinue) {
      // Ký tự continue → giữ trong math
      current += ch;
    } else {
      // Ký tự bình thường khác (chữ tiếng Việt có dấu) → text
      if (currentType === 'math') {
        parts.push({ type: 'math', content: current });
        current = ch;
        currentType = 'text';
      } else {
        current = (current || '') + ch;
        currentType = 'text';
      }
    }
  }
  if (current) {
    parts.push({ type: currentType || 'text', content: current });
  }
  
  // Ghép lại
  return parts.map(p => {
    if (p.type === 'math') {
      return '$' + processMathSegment(p.content) + '$';
    } else {
      return escapeTextMode(p.content);
    }
  }).join('');
}

// Hàm chính được export
function textToLatex(text) {
  if (!text) return '';
  
  const segments = splitByMathMode(text);
  
  return segments.map(seg => {
    if (seg.type === 'math') {
      return '$' + processMathSegment(seg.content) + '$';
    } else {
      return processTextSegment(seg.content);
    }
  }).join('');
}

// Escape tên riêng, tiêu đề (không chứa công thức, CHỈ escape ký tự đặc biệt)
// Dùng cho tên học sinh, môn học, v.v.
function textToLatexPlain(text) {
  return escapeTextMode(text || '');
}

module.exports = {
  textToLatex,
  textToLatexPlain,
  // Export helpers for testing
  _internals: {
    unicodeToMathMode,
    sanitizeLatexCommands,
    escapeTextMode,
    splitByMathMode,
    hasMathContent,
    processTextSegment
  }
};

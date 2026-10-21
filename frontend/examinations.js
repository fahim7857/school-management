// Examinations Management & Marks Entry Frontend Controller

let examinationsList = [];
let currentExamData = null;
let currentMarksSheet = null;
let activeClasses = [];

const apiClient = window.api || (typeof api !== 'undefined' ? api : {
  get: (url, p) => {
    let full = '/abms/api' + url;
    if (p && Object.keys(p).length) {
      const q = new URLSearchParams(p).toString();
      full += (full.includes('?') ? '&' : '?') + q;
    }
    return (window.authFetch ? window.authFetch(full) : fetch(full)).then(r => r.json());
  },
  post: (url, b) => (window.authFetch ? window.authFetch('/abms/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }) : fetch('/abms/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } })).then(r => r.json())
});

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('open', 'active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open', 'active');
    document.body.style.overflow = '';
  }
}

function notify(message, type = 'info') {
  if (typeof window.showToast === 'function') {
    window.showToast(message, type);
    return;
  }
  const existingToast = document.querySelector('.toast-notification');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#2563eb'};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
    z-index: 9999;
    font-size: 0.85rem;
    font-weight: 600;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// Grading scale helper
function calculateGradeAndGpa(score) {
  const s = Math.round(score * 2) / 2;
  if (s >= 90) return { grade: 'A+', gpa: '5.00' };
  if (s >= 80) return { grade: 'A', gpa: '4.50' };
  if (s >= 70) return { grade: 'B+', gpa: '4.00' };
  if (s >= 60) return { grade: 'B', gpa: '3.00' };
  if (s >= 50) return { grade: 'C', gpa: '2.00' };
  if (s >= 40) return { grade: 'D', gpa: '1.00' };
  return { grade: 'F', gpa: '0.00' };
}

document.addEventListener('DOMContentLoaded', async () => {
  const topDate = document.getElementById('topbarDate');
  if (topDate) {
    const now = new Date();
    topDate.textContent = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  setupEventListeners();

  if (window.authReady) {
    try { await window.authReady; } catch (e) { }
  }

  await loadInitialData();
});

function setupEventListeners() {
  document.getElementById('examStreamFilter')?.addEventListener('change', loadExams);

  document.getElementById('openAddExamModalBtn')?.addEventListener('click', () => {
    document.getElementById('examForm').reset();
    showModal('examModal');
  });

  document.getElementById('examStreamSelect')?.addEventListener('change', (e) => {
    const isHifz = e.target.value === 'Hifz';
    const weightRow = document.getElementById('weightingRow');
    if (weightRow) weightRow.style.display = isHifz ? 'none' : 'flex';
  });

  document.getElementById('examForm')?.addEventListener('submit', handleCreateExam);

  // Marks sheet cascading selectors
  document.getElementById('sheetExamSelect')?.addEventListener('change', handleExamSelectChange);
  document.getElementById('sheetClassSelect')?.addEventListener('change', handleClassSelectChange);
  document.getElementById('sheetSubjectSelect')?.addEventListener('change', loadMarksSheet);

  // Save Marks Button
  document.getElementById('saveMarksBtn')?.addEventListener('click', handleSaveMarks);

  // Result Cards Link
  document.getElementById('viewResultCardsBtn')?.addEventListener('click', () => {
    const examId = document.getElementById('sheetExamSelect')?.value;
    const classId = document.getElementById('sheetClassSelect')?.value;
    if (examId && classId) {
      window.location.href = `result-cards.html?exam_id=${examId}&class_id=${classId}`;
    }
  });

  // Attendance entry listeners
  setupAttendanceListeners();
}

async function loadInitialData() {
  try {
    const clsRes = await apiClient.get('/academic/classes');
    if (clsRes && clsRes.success) {
      activeClasses = clsRes.data || [];
    }

    await loadExams();

    // Check URL params for deep link
    const urlParams = new URLSearchParams(window.location.search);
    const examParam = urlParams.get('exam_id');
    const classParam = urlParams.get('class_id');
    if (examParam) {
      const examSel = document.getElementById('sheetExamSelect');
      if (examSel) {
        examSel.value = examParam;
        await handleExamSelectChange();
        if (classParam) {
          const classSel = document.getElementById('sheetClassSelect');
          if (classSel) {
            classSel.value = classParam;
            await handleClassSelectChange();
          }
        }
      }
    }
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

async function loadExams() {
  const tbody = document.getElementById('examsTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">Loading examinations...</td></tr>`;

  try {
    const stream = document.getElementById('examStreamFilter')?.value || '';
    const params = stream ? { stream } : {};

    const res = await apiClient.get('/examinations', params);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load examinations');

    examinationsList = res.data || [];
    renderExamsTable(examinationsList);
    populateExamSelect(examinationsList);
    populateAttExamSelect(examinationsList);
  } catch (err) {
    console.error('Error loading exams:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderExamsTable(exams) {
  const tbody = document.getElementById('examsTableBody');
  if (!tbody) return;

  if (exams.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">No examinations scheduled yet. Click "Create Examination" above.</td></tr>`;
    return;
  }

  tbody.innerHTML = exams.map(e => {
    const streamBadge = e.stream === 'Hifz'
      ? '<span class="rate-badge" style="background: #d1fae5; color: #065f46; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">Hifz</span>'
      : '<span class="rate-badge" style="background: #e0f2fe; color: #0369a1; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">General</span>';

    const formula = e.stream === 'General'
      ? `<span style="font-size: 0.75rem; color: #475569; font-weight: 600;">${e.weight_monthly || 30}% MT + ${e.weight_main || 70}% Main (0.5 Rnd)</span>`
      : `<span style="font-size: 0.75rem; color: #065f46; font-weight: 600;">CT + Final (Direct Max 100)</span>`;

    return `
      <tr>
        <td style="font-weight: 700; color: #004ac6;">${escapeHtml(e.name)}</td>
        <td>${streamBadge}</td>
        <td><span class="badge-tag">${e.exam_type === 'final' ? 'Final Examination' : 'Half-Yearly'}</span></td>
        <td>${e.class_name ? escapeHtml(e.class_name) : 'All Stream Classes'}</td>
        <td>${formula}</td>
        <td>
          <span class="status-pill paid" style="font-size: 0.72rem;">● Active</span>
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-primary btn-sm" onclick="selectExamForMarks(${e.id})" style="font-size: 0.8rem; padding: 0.25rem 0.65rem; background: #004ac6;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">edit_note</span> Enter Marks
          </button>
          <button class="btn btn-secondary btn-sm" onclick="goToResultCards(${e.id})" title="View Progress Reports" style="padding: 0.25rem 0.55rem;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">workspace_premium</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function populateExamSelect(exams) {
  const sel = document.getElementById('sheetExamSelect');
  if (!sel) return;

  let html = '<option value="">Select examination...</option>';
  exams.forEach(e => {
    html += `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.stream)} • ${e.exam_type})</option>`;
  });
  sel.innerHTML = html;
}

async function handleCreateExam(e) {
  e.preventDefault();
  const name = document.getElementById('examNameInput').value.trim();
  const stream = document.getElementById('examStreamSelect').value;
  const exam_type = document.getElementById('examTypeSelect').value;
  const start_date = document.getElementById('examStartDateInput').value;
  const end_date = document.getElementById('examEndDateInput').value;
  const weight_monthly = parseFloat(document.getElementById('examWeightMonthlyInput').value) || 30;
  const weight_main = parseFloat(document.getElementById('examWeightMainInput').value) || 70;

  if (!name) {
    notify('Examination name is required', 'error');
    return;
  }

  try {
    const res = await apiClient.post('/examinations', {
      name,
      stream,
      exam_type,
      start_date,
      end_date,
      weight_monthly,
      weight_main
    });

    if (res && res.success) {
      notify(res.message || 'Examination created successfully!', 'success');
      closeModal('examModal');
      await loadExams();
    } else {
      notify(res?.error || 'Failed to create examination', 'error');
    }
  } catch (err) {
    console.error('Create exam error:', err);
    notify(err.message || 'Failed to create examination', 'error');
  }
}

// ----------------------------------------------------
// MARKS ENTRY LOGIC
// ----------------------------------------------------
async function selectExamForMarks(examId) {
  const sel = document.getElementById('sheetExamSelect');
  if (sel) {
    sel.value = examId;
    await handleExamSelectChange();
    document.getElementById('marksEntryCard')?.scrollIntoView({ behavior: 'smooth' });
  }
}

function goToResultCards(examId) {
  window.location.href = `result-cards.html?exam_id=${examId}`;
}

async function handleExamSelectChange() {
  const examId = document.getElementById('sheetExamSelect')?.value;
  const classSel = document.getElementById('sheetClassSelect');
  const subjSel = document.getElementById('sheetSubjectSelect');
  if (!classSel || !subjSel) return;

  subjSel.innerHTML = '<option value="">Select subject...</option>';

  if (!examId) {
    classSel.innerHTML = '<option value="">Select class...</option>';
    currentExamData = null;
    await loadMarksSheet();
    return;
  }

  const exam = examinationsList.find(e => e.id === parseInt(examId, 10));
  if (!exam) return;

  currentExamData = exam;

  // Filter classes by exam stream (and class_id if exam is class-scoped)
  let filteredClasses = activeClasses.filter(c => c.stream === exam.stream);
  if (exam.class_id) {
    const classScoped = filteredClasses.filter(c => c.id === exam.class_id);
    if (classScoped.length > 0) {
      filteredClasses = classScoped;
    }
  }

  let html = '<option value="">Select class...</option>';
  filteredClasses.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  classSel.innerHTML = html;

  if (exam.class_id) {
    classSel.value = String(exam.class_id);
    await handleClassSelectChange();
  } else if (filteredClasses.length > 0) {
    // Select first class that has active students, or fallback to first class
    const preferredClass = filteredClasses.find(c => (c.student_count || 0) > 0) || filteredClasses[0];
    classSel.value = String(preferredClass.id);
    await handleClassSelectChange();
  } else {
    await loadMarksSheet();
  }
}

async function handleClassSelectChange() {
  const classId = document.getElementById('sheetClassSelect')?.value;
  const subjSel = document.getElementById('sheetSubjectSelect');
  if (!subjSel || !currentExamData) return;

  if (!classId) {
    subjSel.innerHTML = '<option value="">Select subject...</option>';
    await loadMarksSheet();
    return;
  }

  subjSel.innerHTML = '<option value="">Loading subjects...</option>';

  try {
    const res = await apiClient.get('/academic/subjects', {
      class_id: classId,
      stream: currentExamData.stream
    });

    if (res && res.success) {
      const subjects = res.data || [];
      let html = '<option value="">Select subject...</option>';
      subjects.forEach(s => {
        html += `<option value="${s.id}">${escapeHtml(s.name)} (Full: ${s.full_marks || 100})</option>`;
      });
      subjSel.innerHTML = html;

      if (subjects.length > 0) {
        subjSel.value = subjects[0].id;
      }
      await loadMarksSheet();
    }
  } catch (err) {
    console.error('Error fetching subjects for class:', err);
    subjSel.innerHTML = '<option value="">Failed to load subjects</option>';
    await loadMarksSheet();
  }
}

async function loadMarksSheet() {
  const examId = document.getElementById('sheetExamSelect')?.value;
  const classId = document.getElementById('sheetClassSelect')?.value;
  const subjectId = document.getElementById('sheetSubjectSelect')?.value;

  const tbody = document.getElementById('marksSheetTbody');
  const thead = document.getElementById('marksSheetThead');
  const saveBtn = document.getElementById('saveMarksBtn');
  const resultBtn = document.getElementById('viewResultCardsBtn');

  if (!examId || !classId || !subjectId) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #64748b;">Please select an Examination, Class, and Subject above.</td></tr>`;
    if (saveBtn) saveBtn.style.display = 'none';
    if (resultBtn) resultBtn.style.display = 'none';
    return;
  }

  tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #64748b;">Loading students and marks sheet...</td></tr>`;

  try {
    const res = await apiClient.get(`/examinations/${examId}/marks-sheet`, {
      class_id: classId,
      subject_id: subjectId
    });

    if (!res || !res.success) throw new Error(res?.error || 'Failed to load marks sheet');

    currentMarksSheet = res.data;
    renderMarksSheetGrid(currentMarksSheet);

    const hasStudents = currentMarksSheet.students && currentMarksSheet.students.length > 0;
    if (saveBtn) saveBtn.style.display = hasStudents ? 'inline-flex' : 'none';
    if (resultBtn) resultBtn.style.display = hasStudents ? 'inline-flex' : 'none';
  } catch (err) {
    console.error('Error loading marks sheet:', err);
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
    if (saveBtn) saveBtn.style.display = 'none';
    if (resultBtn) resultBtn.style.display = 'none';
  }
}

function renderMarksSheetGrid(sheetData) {
  const exam = sheetData.exam;
  const students = sheetData.students || [];
  const marks = sheetData.marks || [];
  const thead = document.getElementById('marksSheetThead');
  const tbody = document.getElementById('marksSheetTbody');

  const isHifz = exam.stream === 'Hifz';
  const isFinal = exam.exam_type === 'final';

  // 1. Build Header
  if (isHifz) {
    thead.innerHTML = `
      <tr>
        <th style="width: 70px;">Roll</th>
        <th>Student Name</th>
        <th style="width: 140px;">Class Test (CT)</th>
        <th style="width: 140px;">Final Exam</th>
        <th style="width: 130px;">Total (Max 100)</th>
        <th style="width: 110px;">Grade & GP</th>
        <th style="width: 90px; text-align: center;">Absent?</th>
      </tr>
    `;
  } else {
    const wMonthly = currentExamData?.weight_monthly !== undefined ? currentExamData.weight_monthly : 30;
    const wMain = currentExamData?.weight_main !== undefined ? currentExamData.weight_main : 70;

    thead.innerHTML = `
      <tr>
        <th style="width: 70px;">Roll</th>
        <th>Student Name</th>
        <th style="width: 110px;">${isFinal ? 'MT 3 (100)' : 'MT 1 (100)'}</th>
        <th style="width: 110px;">${isFinal ? 'MT 4 (100)' : 'MT 2 (100)'}</th>
        <th style="width: 110px;">MT Avg (${wMonthly}%)</th>
        <th style="width: 120px;">${isFinal ? 'Final Exam (100)' : 'Main Exam (100)'}</th>
        <th style="width: 110px;">Main (${wMain}%)</th>
        <th style="width: 130px; font-weight: 800; color: #004ac6;">Final Score (0.5 Rnd)</th>
        <th style="width: 110px;">Grade & GP</th>
        <th style="width: 90px; text-align: center;">Absent?</th>
      </tr>
    `;
  }

  // 2. Build Student Rows
  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #64748b;">No active students found in this class.</td></tr>`;
    return;
  }

  tbody.innerHTML = students.map(st => {
    const existing = marks.find(m => m.student_id === st.id) || {};
    const isAbsent = existing.is_absent === 1;

    if (isHifz) {
      const ctVal = existing.ct_marks !== null && existing.ct_marks !== undefined ? existing.ct_marks : '';
      const finalVal = existing.final_exam !== null && existing.final_exam !== undefined ? existing.final_exam : '';
      const totalScore = existing.final_score !== null && existing.final_score !== undefined ? existing.final_score : 0;
      const gradeInfo = calculateGradeAndGpa(totalScore);

      return `
        <tr data-student-id="${st.id}" class="marks-row">
          <td style="font-weight: 700; color: #004ac6;">#${st.roll_number}</td>
          <td style="font-weight: 600; color: #0f172a;">${escapeHtml(st.name)}</td>
          <td>
            <input type="number" class="form-control mark-input ct-input" min="0" max="100" step="any"
                   value="${ctVal}" ${isAbsent ? 'disabled' : ''} style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td>
            <input type="number" class="form-control mark-input final-input" min="0" max="100" step="any"
                   value="${finalVal}" ${isAbsent ? 'disabled' : ''} style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td style="font-weight: 800; color: #16a34a; font-size: 0.95rem;" class="cell-final-score">
            ${isAbsent ? '0' : totalScore}
          </td>
          <td class="cell-grade-gpa">
            <span class="rate-badge" style="font-weight: 700; background: #e0f2fe; color: #0369a1;">
              ${isAbsent ? 'F (0.00)' : `${gradeInfo.grade} (${gradeInfo.gpa})`}
            </span>
          </td>
          <td style="text-align: center;">
            <input type="checkbox" class="absent-check" ${isAbsent ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;">
          </td>
        </tr>
      `;
    } else {
      // General Stream
      const mt1Val = (isFinal ? existing.mt3 : existing.mt1) ?? '';
      const mt2Val = (isFinal ? existing.mt4 : existing.mt2) ?? '';
      const mainVal = (isFinal ? existing.final_exam : existing.main_exam) ?? '';
      const totalScore = existing.final_score ?? 0;
      const gradeInfo = calculateGradeAndGpa(totalScore);

      return `
        <tr data-student-id="${st.id}" class="marks-row">
          <td style="font-weight: 700; color: #004ac6;">#${st.roll_number}</td>
          <td style="font-weight: 600; color: #0f172a;">${escapeHtml(st.name)}</td>
          <td>
            <input type="number" class="form-control mark-input mt1-input" min="0" max="100" step="any"
                   value="${mt1Val}" ${isAbsent ? 'disabled' : ''} style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td>
            <input type="number" class="form-control mark-input mt2-input" min="0" max="100" step="any"
                   value="${mt2Val}" ${isAbsent ? 'disabled' : ''} style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td style="font-weight: 600; color: #475569;" class="cell-mt-30">
            0
          </td>
          <td>
            <input type="number" class="form-control mark-input main-input" min="0" max="100" step="any"
                   value="${mainVal}" ${isAbsent ? 'disabled' : ''} style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td style="font-weight: 600; color: #475569;" class="cell-main-70">
            0
          </td>
          <td style="font-weight: 800; color: #004ac6; font-size: 0.95rem;" class="cell-final-score">
            ${isAbsent ? '0' : totalScore}
          </td>
          <td class="cell-grade-gpa">
            <span class="rate-badge" style="font-weight: 700; background: #e0f2fe; color: #0369a1;">
              ${isAbsent ? 'F (0.00)' : `${gradeInfo.grade} (${gradeInfo.gpa})`}
            </span>
          </td>
          <td style="text-align: center;">
            <input type="checkbox" class="absent-check" ${isAbsent ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;">
          </td>
        </tr>
      `;
    }
  }).join('');

  // Attach live calculation events
  attachMarksCalculationListeners(isHifz);
}

function attachMarksCalculationListeners(isHifz) {
  const rows = document.querySelectorAll('.marks-row');
  rows.forEach(row => {
    const absentCheck = row.querySelector('.absent-check');
    const inputs = row.querySelectorAll('.mark-input');

    const recalculateRow = () => {
      const isAbsent = absentCheck.checked;
      inputs.forEach(inp => inp.disabled = isAbsent);

      const scoreCell = row.querySelector('.cell-final-score');
      const gradeCell = row.querySelector('.cell-grade-gpa');

      if (isAbsent) {
        scoreCell.textContent = '0';
        gradeCell.innerHTML = `<span class="rate-badge" style="background:#fee2e2; color:#b91c1c; font-weight:700;">F (0.00)</span>`;
        return;
      }

      if (isHifz) {
        const ct = parseFloat(row.querySelector('.ct-input')?.value) || 0;
        const fin = parseFloat(row.querySelector('.final-input')?.value) || 0;
        const raw = ct + fin;
        const finalScore = Math.min(100, Math.round(raw * 2) / 2);
        const { grade, gpa } = calculateGradeAndGpa(finalScore);

        scoreCell.textContent = finalScore;
        gradeCell.innerHTML = `<span class="rate-badge" style="background:#e0f2fe; color:#0369a1; font-weight:700;">${grade} (${gpa})</span>`;
      } else {
        const mt1 = row.querySelector('.mt1-input')?.value;
        const mt2 = row.querySelector('.mt2-input')?.value;
        const main = row.querySelector('.main-input')?.value;

        const wMonthly = currentExamData?.weight_monthly !== undefined ? currentExamData.weight_monthly : 30;
        const wMain = currentExamData?.weight_main !== undefined ? currentExamData.weight_main : 70;

        let mtCount = 0;
        let mtSum = 0;
        if (mt1 !== '' && !isNaN(parseFloat(mt1))) { mtSum += parseFloat(mt1); mtCount++; }
        if (mt2 !== '' && !isNaN(parseFloat(mt2))) { mtSum += parseFloat(mt2); mtCount++; }

        const mtAvg = mtCount > 0 ? (mtSum / mtCount) : 0;
        const mtWeighted = (mtAvg * wMonthly) / 100;
        const mainWeighted = (main !== '' && !isNaN(parseFloat(main))) ? (parseFloat(main) * wMain) / 100 : 0;

        const raw = mtWeighted + mainWeighted;
        const finalScore = Math.min(100, Math.round(raw * 2) / 2);
        const { grade, gpa } = calculateGradeAndGpa(finalScore);

        const mtCell = row.querySelector('.cell-mt-30');
        if (mtCell) mtCell.textContent = Math.round(mtWeighted * 10) / 10;
        const mainCell = row.querySelector('.cell-main-70');
        if (mainCell) mainCell.textContent = Math.round(mainWeighted * 10) / 10;

        scoreCell.textContent = finalScore;
        gradeCell.innerHTML = `<span class="rate-badge" style="background:#e0f2fe; color:#0369a1; font-weight:700;">${grade} (${gpa})</span>`;
      }
    };

    inputs.forEach(inp => inp.addEventListener('input', recalculateRow));
    absentCheck.addEventListener('change', recalculateRow);

    // Initial calculate
    recalculateRow();
  });
}

async function handleSaveMarks() {
  const examId = document.getElementById('sheetExamSelect')?.value;
  const classId = document.getElementById('sheetClassSelect')?.value;
  const subjectId = document.getElementById('sheetSubjectSelect')?.value;

  if (!examId || !classId || !subjectId) {
    notify('Please select an examination, class, and subject', 'error');
    return;
  }

  const isHifz = currentExamData?.stream === 'Hifz';
  const isFinal = currentExamData?.exam_type === 'final';

  const rows = document.querySelectorAll('.marks-row');
  if (rows.length === 0) {
    notify('No students found to save marks for', 'error');
    return;
  }
  const marksList = [];

  rows.forEach(row => {
    const studentId = row.getAttribute('data-student-id');
    const isAbsent = row.querySelector('.absent-check').checked;

    if (isHifz) {
      const ctVal = row.querySelector('.ct-input')?.value;
      const finalVal = row.querySelector('.final-input')?.value;
      marksList.push({
        student_id: parseInt(studentId, 10),
        subject_id: parseInt(subjectId, 10),
        class_id: parseInt(classId, 10),
        ct_marks: ctVal !== '' ? parseFloat(ctVal) : null,
        final_exam: finalVal !== '' ? parseFloat(finalVal) : null,
        is_absent: isAbsent
      });
    } else {
      const mt1 = row.querySelector('.mt1-input')?.value;
      const mt2 = row.querySelector('.mt2-input')?.value;
      const main = row.querySelector('.main-input')?.value;

      const item = {
        student_id: parseInt(studentId, 10),
        subject_id: parseInt(subjectId, 10),
        class_id: parseInt(classId, 10),
        is_absent: isAbsent
      };

      if (isFinal) {
        item.mt3 = mt1 !== '' ? parseFloat(mt1) : null;
        item.mt4 = mt2 !== '' ? parseFloat(mt2) : null;
        item.final_exam = main !== '' ? parseFloat(main) : null;
      } else {
        item.mt1 = mt1 !== '' ? parseFloat(mt1) : null;
        item.mt2 = mt2 !== '' ? parseFloat(mt2) : null;
        item.main_exam = main !== '' ? parseFloat(main) : null;
      }
      marksList.push(item);
    }
  });


  const saveBtn = document.getElementById('saveMarksBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving Marks...';
  }

  try {
    const res = await apiClient.post(`/examinations/${examId}/save-marks`, {
      marks_list: marksList
    });

    if (res && res.success) {
      notify(res.message || 'Marks saved successfully!', 'success');
      await loadMarksSheet();
    } else {
      notify(res?.error || 'Failed to save marks', 'error');
    }
  } catch (err) {
    console.error('Save marks error:', err);
    notify(err.message || 'Failed to save marks', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem;">save</span> Save All Marks';
    }
  }
}

window.selectExamForMarks = selectExamForMarks;
window.goToResultCards = goToResultCards;
window.closeModal = closeModal;
window.showModal = showModal;

// ====================================================
// ATTENDANCE ENTRY LOGIC
// ====================================================

let attCurrentExam = null;

function setupAttendanceListeners() {
  document.getElementById('attExamSelect')?.addEventListener('change', handleAttExamChange);
  document.getElementById('attClassSelect')?.addEventListener('change', loadAttendanceSheet);
  document.getElementById('attWorkingDays')?.addEventListener('input', recalculateAllAttendance);
  document.getElementById('saveAttendanceBtn')?.addEventListener('click', handleSaveAttendance);
}

function populateAttExamSelect(exams) {
  const sel = document.getElementById('attExamSelect');
  if (!sel) return;
  let html = '<option value="">Select examination...</option>';
  exams.forEach(e => {
    html += `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.stream)} • ${e.exam_type})</option>`;
  });
  sel.innerHTML = html;
}

async function handleAttExamChange() {
  const examId = document.getElementById('attExamSelect')?.value;
  const classSel = document.getElementById('attClassSelect');
  if (!classSel) return;

  if (!examId) {
    classSel.innerHTML = '<option value="">Select class...</option>';
    attCurrentExam = null;
    clearAttendanceSheet();
    return;
  }

  const exam = examinationsList.find(e => e.id === parseInt(examId, 10));
  if (!exam) return;
  attCurrentExam = exam;

  let filteredClasses = activeClasses.filter(c => c.stream === exam.stream);
  if (exam.class_id) {
    const scoped = filteredClasses.filter(c => c.id === exam.class_id);
    if (scoped.length > 0) filteredClasses = scoped;
  }

  let html = '<option value="">Select class...</option>';
  filteredClasses.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  classSel.innerHTML = html;

  if (filteredClasses.length > 0) {
    classSel.value = String(filteredClasses[0].id);
    await loadAttendanceSheet();
  } else {
    clearAttendanceSheet();
  }
}

function clearAttendanceSheet() {
  const tbody = document.getElementById('attendanceSheetTbody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 3rem; color: #64748b;">Please select an Examination and Class above to load students for attendance entry.</td></tr>`;
  }
  const saveBtn = document.getElementById('saveAttendanceBtn');
  if (saveBtn) saveBtn.style.display = 'none';
  const wdInput = document.getElementById('attWorkingDays');
  if (wdInput) wdInput.value = '';
}

async function loadAttendanceSheet() {
  const examId = document.getElementById('attExamSelect')?.value;
  const classId = document.getElementById('attClassSelect')?.value;
  const tbody = document.getElementById('attendanceSheetTbody');
  const saveBtn = document.getElementById('saveAttendanceBtn');

  if (!examId || !classId) {
    clearAttendanceSheet();
    return;
  }

  tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #64748b;">Loading students...</td></tr>`;

  try {
    const res = await apiClient.get(`/examinations/${examId}/attendance`, { class_id: classId });
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load attendance');

    const data = res.data;
    const wdInput = document.getElementById('attWorkingDays');

    // Pre-fill working days from existing data
    if (data.total_working_days !== '' && data.total_working_days !== null && data.total_working_days !== undefined) {
      wdInput.value = data.total_working_days;
    }

    const students = data.students || [];
    if (students.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">No active students found in this class.</td></tr>`;
      if (saveBtn) saveBtn.style.display = 'none';
      return;
    }

    const wDays = parseInt(wdInput.value, 10) || 0;

    tbody.innerHTML = students.map(st => {
      const presVal = (st.presence !== null && st.presence !== undefined) ? st.presence : '';
      const pres = presVal !== '' ? parseInt(presVal, 10) : 0;
      const abs = wDays > 0 && presVal !== '' ? Math.max(0, wDays - pres) : '-';
      const pct = wDays > 0 && presVal !== '' ? (Math.round((pres / wDays) * 1000) / 10) : '-';
      const teacherRemarks = st.class_teacher_remarks || '';
      const principalRemarks = st.principal_remarks || '';

      return `
        <tr data-student-id="${st.student_id}" class="att-row">
          <td style="font-weight: 700; color: #004ac6;">#${st.roll_number}</td>
          <td style="font-weight: 600; color: #0f172a;">${escapeHtml(st.name)}</td>
          <td>
            <input type="number" class="form-control att-presence-input" min="0" max="365" step="1"
                   value="${presVal}" style="padding: 0.35rem 0.5rem; font-size: 0.85rem;">
          </td>
          <td class="cell-absent" style="font-weight: 600; color: #dc2626;">${abs}</td>
          <td class="cell-att-pct" style="font-weight: 700; color: #004ac6;">${pct !== '-' ? pct + '%' : '-'}</td>
          <td>
            <input type="text" class="form-control att-teacher-remarks" placeholder="Optional teacher remarks..."
                   value="${escapeHtml(teacherRemarks)}" style="padding: 0.35rem 0.5rem; font-size: 0.85rem; width: 100%;">
          </td>
          <td>
            <input type="text" class="form-control att-principal-remarks" placeholder="Optional principal remarks..."
                   value="${escapeHtml(principalRemarks)}" style="padding: 0.35rem 0.5rem; font-size: 0.85rem; width: 100%;">
          </td>
        </tr>
      `;
    }).join('');

    if (saveBtn) saveBtn.style.display = 'inline-flex';

    // Attach live recalculation on presence input change
    attachAttendanceCalcListeners();
  } catch (err) {
    console.error('Error loading attendance sheet:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
    if (saveBtn) saveBtn.style.display = 'none';
  }
}

function attachAttendanceCalcListeners() {
  const rows = document.querySelectorAll('.att-row');
  rows.forEach(row => {
    const presInput = row.querySelector('.att-presence-input');
    if (presInput) {
      presInput.addEventListener('input', () => recalcAttRow(row));
    }
  });
}

function recalcAttRow(row) {
  const wDays = parseInt(document.getElementById('attWorkingDays')?.value, 10) || 0;
  const presInput = row.querySelector('.att-presence-input');
  const absCell = row.querySelector('.cell-absent');
  const pctCell = row.querySelector('.cell-att-pct');

  const pres = parseInt(presInput.value, 10);

  if (isNaN(pres) || presInput.value === '') {
    absCell.textContent = '-';
    pctCell.textContent = '-';
    return;
  }

  if (wDays > 0) {
    const abs = Math.max(0, wDays - pres);
    absCell.textContent = abs;
    const pct = Math.round((pres / wDays) * 1000) / 10;
    pctCell.textContent = pct + '%';
  } else {
    absCell.textContent = '-';
    pctCell.textContent = '-';
  }
}

function recalculateAllAttendance() {
  const rows = document.querySelectorAll('.att-row');
  rows.forEach(row => recalcAttRow(row));
}

async function handleSaveAttendance() {
  const examId = document.getElementById('attExamSelect')?.value;
  const classId = document.getElementById('attClassSelect')?.value;
  const wDays = document.getElementById('attWorkingDays')?.value;

  if (!examId || !classId) {
    notify('Please select an examination and class', 'error');
    return;
  }

  const totalWorkingDays = parseInt(wDays, 10);
  if (isNaN(totalWorkingDays) || totalWorkingDays < 0) {
    notify('Total working days must be a non-negative number', 'error');
    return;
  }

  const rows = document.querySelectorAll('.att-row');
  if (rows.length === 0) {
    notify('No students found', 'error');
    return;
  }

  const attendance_list = [];
  let hasError = false;

  rows.forEach(row => {
    if (hasError) return;
    const studentId = row.getAttribute('data-student-id');
    const presInput = row.querySelector('.att-presence-input');
    const teacherRemarksInput = row.querySelector('.att-teacher-remarks');
    const principalRemarksInput = row.querySelector('.att-principal-remarks');
    const presVal = presInput.value.trim();

    const teacherRemarks = teacherRemarksInput ? teacherRemarksInput.value.trim() : '';
    const principalRemarks = principalRemarksInput ? principalRemarksInput.value.trim() : '';

    if (presVal === '') {
      // Skip students with empty present days — treat as 0
      attendance_list.push({
        student_id: parseInt(studentId, 10),
        presence: 0,
        class_teacher_remarks: teacherRemarks,
        principal_remarks: principalRemarks
      });
      return;
    }

    const pres = parseInt(presVal, 10);
    if (isNaN(pres) || pres < 0) {
      notify(`Invalid present days for student. Must be >= 0.`, 'error');
      hasError = true;
      return;
    }
    if (pres > totalWorkingDays) {
      notify(`Present days (${pres}) cannot exceed total working days (${totalWorkingDays}).`, 'error');
      hasError = true;
      return;
    }

    attendance_list.push({
      student_id: parseInt(studentId, 10),
      presence: pres,
      class_teacher_remarks: teacherRemarks,
      principal_remarks: principalRemarks
    });
  });

  if (hasError) return;

  const saveBtn = document.getElementById('saveAttendanceBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    const res = await apiClient.post(`/examinations/${examId}/attendance`, {
      class_id: parseInt(classId, 10),
      total_working_days: totalWorkingDays,
      attendance_list
    });

    if (res && res.success) {
      notify(res.message || 'Attendance saved successfully!', 'success');
      await loadAttendanceSheet();
    } else {
      notify(res?.error || 'Failed to save attendance', 'error');
    }
  } catch (err) {
    console.error('Save attendance error:', err);
    notify(err.message || 'Failed to save attendance', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem;">save</span> Save Attendance';
    }
  }
}


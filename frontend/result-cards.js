// Aleya Begum Modern School Result Cards & Progress Report Controller

let examinations = [];
let classesList = [];
let currentResultsData = null;

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

function formatOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();

  if (window.authReady) {
    try { await window.authReady; } catch (e) { }
  }

  await loadInitialFilters();
});

function setupEventListeners() {
  document.getElementById('cardExamSelect')?.addEventListener('change', handleExamChange);
  document.getElementById('cardClassSelect')?.addEventListener('change', handleClassChange);
  document.getElementById('loadCardsBtn')?.addEventListener('click', generateResultCards);
  document.getElementById('openEditMetaBtn')?.addEventListener('click', openMetaEditor);
  document.getElementById('metaForm')?.addEventListener('submit', handleSaveStudentMeta);
  document.getElementById('printAllBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    printAllResults();
  });
}

async function loadInitialFilters() {
  try {
    const [examRes, clsRes] = await Promise.all([
      apiClient.get('/examinations'),
      apiClient.get('/academic/classes')
    ]);

    if (examRes && examRes.success) {
      examinations = examRes.data || [];
      populateExamDropdown(examinations);
    }

    if (clsRes && clsRes.success) {
      classesList = clsRes.data || [];
    }

    // Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const examParam = urlParams.get('exam_id');
    const classParam = urlParams.get('class_id');
    const studentParam = urlParams.get('student_id');

    if (examParam) {
      const examSel = document.getElementById('cardExamSelect');
      if (examSel) {
        examSel.value = examParam;
        await handleExamChange();

        if (classParam) {
          const clsSel = document.getElementById('cardClassSelect');
          if (clsSel) {
            clsSel.value = classParam;
            await handleClassChange();

            if (studentParam) {
              const stSel = document.getElementById('cardStudentSelect');
              if (stSel) stSel.value = studentParam;
            }

            await generateResultCards();
          }
        }
      }
    }
  } catch (err) {
    console.error('Error loading filters:', err);
  }
}

function populateExamDropdown(exams) {
  const sel = document.getElementById('cardExamSelect');
  if (!sel) return;

  let html = '<option value="">Select examination...</option>';
  exams.forEach(e => {
    html += `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.stream)})</option>`;
  });
  sel.innerHTML = html;
}

async function handleExamChange() {
  const examId = document.getElementById('cardExamSelect')?.value;
  const clsSel = document.getElementById('cardClassSelect');
  const stuSel = document.getElementById('cardStudentSelect');
  if (!clsSel || !stuSel) return;

  stuSel.innerHTML = '<option value="">All Students in Class</option>';

  if (!examId) {
    clsSel.innerHTML = '<option value="">Select class...</option>';
    return;
  }

  const exam = examinations.find(e => e.id === parseInt(examId, 10));
  if (!exam) return;

  const filtered = classesList.filter(c => c.stream === exam.stream);
  let html = '<option value="">Select class...</option>';
  filtered.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  clsSel.innerHTML = html;

  if (filtered.length > 0) {
    clsSel.value = filtered[0].id;
    await handleClassChange();
  }
}

async function handleClassChange() {
  const examId = document.getElementById('cardExamSelect')?.value;
  const classId = document.getElementById('cardClassSelect')?.value;
  const stuSel = document.getElementById('cardStudentSelect');
  if (!stuSel || !examId || !classId) return;

  const exam = examinations.find(e => e.id === parseInt(examId, 10));
  if (!exam) return;

  stuSel.innerHTML = '<option value="">Loading students...</option>';

  try {
    const res = await apiClient.get('/students', {
      class_id: classId,
      stream: exam.stream
    });

    const students = res.data || [];
    let html = '<option value="">All Students in Class</option>';
    students.forEach(st => {
      html += `<option value="${st.id}">#${st.roll_number} - ${escapeHtml(st.name)}</option>`;
    });
    stuSel.innerHTML = html;
  } catch (err) {
    console.error('Failed to load students:', err);
    stuSel.innerHTML = '<option value="">All Students in Class</option>';
  }
}

async function generateResultCards() {
  const examId = document.getElementById('cardExamSelect')?.value;
  const classId = document.getElementById('cardClassSelect')?.value;
  const selectedStudentId = document.getElementById('cardStudentSelect')?.value;
  const container = document.getElementById('resultCardsContainer');

  if (!examId || !classId) {
    notify('Please select both an Examination and Class', 'error');
    return;
  }

  container.innerHTML = `
    <div style="text-align: center; padding: 4rem 1rem; color: #64748b; background: white; border-radius: 8px;" class="no-print">
      <span class="material-symbols-outlined" style="font-size: 3rem; color: #004ac6; animation: spin 1s infinite linear;">sync</span>
      <h4 style="margin: 0.5rem 0 0 0; color: #0f172a;">Compiling examination results and ranking...</h4>
    </div>
  `;

  try {
    const res = await apiClient.get(`/examinations/${examId}/results`, { class_id: classId });
    if (!res || !res.success) throw new Error(res?.error || 'Failed to calculate results');

    currentResultsData = res.data;
    let results = currentResultsData.results || [];

    if (selectedStudentId) {
      results = results.filter(r => r.student_id === parseInt(selectedStudentId, 10));
    }

    if (results.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem; background: white; border-radius: 8px; color: #64748b;" class="no-print">
          No student results found for this selection. Ensure marks are entered in the Examinations page.
        </div>
      `;
      return;
    }

    renderAllCards(currentResultsData, results);
  } catch (err) {
    console.error('Results error:', err);
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem; background: white; border-radius: 8px; color: #dc2626;" class="no-print">
        Error generating result cards: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

function renderAllCards(data, results) {
  const container = document.getElementById('resultCardsContainer');
  const exam = data.exam;
  const isHifz = exam.stream === 'Hifz';

  const cardsHtml = results.map(st => {
    const rankDisplay = formatOrdinal(st.position || 1);
    const passClass = st.overall_grade === 'F' ? 'color: #dc2626;' : 'color: #16a34a;';

    // Subject Rows
    const subjectsRows = (st.subjects || []).map(sub => `
      <tr>
        <td class="subject-name">${escapeHtml(sub.subject_name)}</td>
        <td>${sub.full_marks || 100}</td>
        <td>${isHifz ? sub.term_marks : sub.term_marks}</td>
        <td>${isHifz ? sub.mt_marks : sub.mt_marks}</td>
        <td style="font-weight: 700; color: #004ac6;">${sub.total_marks}</td>
        <td style="color: #64748b;">${sub.highest_marks}</td>
        <td style="font-weight: 700;">${sub.grade}</td>
        <td style="font-weight: 700;">${sub.grade_point}</td>
      </tr>
    `).join('');

    return `
      <div class="report-card-container-item">
        <div class="no-print" style="max-width: 820px; margin: 0 auto 0.4rem auto; display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="printSingleCard(${st.student_id})" style="font-size: 0.75rem; padding: 0.25rem 0.65rem; display: inline-flex; align-items: center; gap: 0.3rem; background: white; border: 1px solid #cbd5e1; cursor: pointer;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">print</span> Print Student Card
          </button>
        </div>
        <div class="report-card-wrapper">
        <!-- Official Header -->
        <div class="report-header">
          <div class="report-logo-box">
            <img src="assets/abms_logo.jpg" alt="ABMS Logo" onerror="this.src='../assets/abms_logo.jpg'">
          </div>
          <div class="report-title-box">
            <h1 class="report-school-name">ALEYA BEGUM MODERN SCHOOL</h1>
            <p class="report-school-subtitle">Excellence in Academic and Moral Education</p>
            <div class="report-badge-box">PROGRESS REPORT</div>
            <div class="report-exam-subtext">${escapeHtml(exam.name)} • ${escapeHtml(st.stream)} Stream</div>
          </div>
          <div class="report-logo-box" style="justify-content: flex-end;">
            <div style="border: 2px solid #004ac6; border-radius: 6px; padding: 6px 12px; text-align: center; background: #f0f7ff;">
              <div style="font-size: 0.65rem; font-weight: 800; color: #64748b; text-transform: uppercase;">Merit Rank</div>
              <div style="font-size: 1.35rem; font-weight: 900; color: #004ac6; line-height: 1;">${rankDisplay}</div>
            </div>
          </div>
        </div>

        <!-- Student Information Grid -->
        <div class="report-student-grid">
          <div class="report-info-item">
            <span class="report-info-label">Student's Name</span>
            <span class="report-info-val" style="color: #004ac6; font-size: 0.95rem;">${escapeHtml(st.name)}</span>
          </div>
          <div class="report-info-item">
            <span class="report-info-label">Class</span>
            <span class="report-info-val">${escapeHtml(st.class_name)}</span>
          </div>
          <div class="report-info-item">
            <span class="report-info-label">Roll Number</span>
            <span class="report-info-val">#${st.roll}</span>
          </div>
          <div class="report-info-item">
            <span class="report-info-label">Academic Stream</span>
            <span class="report-info-val">${escapeHtml(st.stream)}</span>
          </div>
          <div class="report-info-item" style="grid-column: span 2;">
            <span class="report-info-label">Father's Name</span>
            <span class="report-info-val">${escapeHtml(st.father_name || 'N/A')}</span>
          </div>
          <div class="report-info-item" style="grid-column: span 2;">
            <span class="report-info-label">Mother's Name</span>
            <span class="report-info-val">${escapeHtml(st.mother_name || 'N/A')}</span>
          </div>
        </div>

        <!-- Subject Marks Table -->
        <table class="report-table">
          <thead>
            <tr>
              <th style="text-align: left;">Name of Subjects</th>
              <th style="width: 75px;">Full Marks</th>
              <th style="width: 85px;">${isHifz ? 'Final Exam' : 'Term Exam (70%)'}</th>
              <th style="width: 85px;">${isHifz ? 'Class Test' : 'MT (30%)'}</th>
              <th style="width: 95px; color: #004ac6;">Total Marks</th>
              <th style="width: 80px;">Highest</th>
              <th style="width: 65px;">Grade</th>
              <th style="width: 65px;">GP</th>
            </tr>
          </thead>
          <tbody>
            ${subjectsRows}
            <tr class="total-row">
              <td class="subject-name" style="font-weight: 800; color: #0f172a;">GRAND TOTAL / OVERALL</td>
              <td>${st.grand_total_marks}</td>
              <td colspan="2" style="font-size: 0.75rem; color: #64748b;">Obtained: <strong>${st.total_marks_obtained}</strong></td>
              <td style="font-weight: 900; color: #004ac6; font-size: 0.95rem;">${st.total_marks_obtained}</td>
              <td style="font-size: 0.72rem; color: #64748b;">Avg: ${st.average_marks}%</td>
              <td style="font-weight: 900; ${passClass}">${st.overall_grade}</td>
              <td style="font-weight: 900; ${passClass}">${st.obtained_gpa.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>

        <!-- Lower Grid: Attendance & Grading Scale -->
        <div class="report-lower-grid">
          <!-- Attendance & Character Assessment -->
          <div class="report-sub-card">
            <div class="report-sub-title">Attendance & Conduct Profile</div>
            <table class="mini-data-table">
              <tr>
                <td>Total Working Days</td>
                <td style="font-weight: 700; text-align: right;">${st.total_working_days ?? '-'}</td>
                <td>Presence (Days)</td>
                <td style="font-weight: 700; text-align: right;">${st.presence ?? '-'}</td>
              </tr>
              <tr>
                <td>Absent (Days)</td>
                <td style="font-weight: 700; text-align: right;">${st.absent ?? '-'}</td>
                <td>Attendance %</td>
                <td style="font-weight: 700; text-align: right; color: #004ac6;">${st.percentage_of_attendance !== undefined && st.percentage_of_attendance !== null && st.percentage_of_attendance !== '' ? st.percentage_of_attendance + '%' : '-'}</td>
              </tr>
              <tr>
                <td colspan="2">Manners & Discipline</td>
                <td colspan="2" style="font-weight: 700; text-align: center; color: #166534; background: #f0fdf4;">
                  ${escapeHtml(st.manners_discipline || '-')}
                </td>
              </tr>
              <tr>
                <td colspan="2">Final Result Status</td>
                <td colspan="2" style="font-weight: 800; text-align: center; ${passClass}">
                  ${st.overall_grade === 'F' ? 'FAILED' : 'PASSED & PROMOTED'}
                </td>
              </tr>
            </table>
          </div>

          <!-- Official Grading Scale -->
          <div class="report-sub-card">
            <div class="report-sub-title">Official Grading Scale</div>
            <table class="mini-data-table" style="text-align: center;">
              <thead>
                <tr>
                  <th>Range</th>
                  <th>Grade</th>
                  <th>GP</th>
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>90 - 100</td><td style="font-weight:700;">A+</td><td>5.00</td><td>Outstanding</td></tr>
                <tr><td>80 - 89</td><td style="font-weight:700;">A</td><td>4.50</td><td>Very Good</td></tr>
                <tr><td>70 - 79</td><td style="font-weight:700;">B+</td><td>4.00</td><td>Good</td></tr>
                <tr><td>60 - 69</td><td style="font-weight:700;">B</td><td>3.00</td><td>Satisfactory</td></tr>
                <tr><td>50 - 59</td><td style="font-weight:700;">C</td><td>2.00</td><td>Acceptable</td></tr>
                <tr><td>40 - 49</td><td style="font-weight:700;">D</td><td>1.00</td><td>Marginal</td></tr>
                <tr><td>00 - 39</td><td style="font-weight:700; color:#dc2626;">F</td><td>0.00</td><td>Fail</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Remarks Section -->
        <div class="report-remarks-grid">
          <div class="remarks-box">
            <div class="remarks-title">Class Teacher's Remarks</div>
            <div style="font-style: italic; color: #1e293b;">${st.class_teacher_remarks ? `"${escapeHtml(st.class_teacher_remarks)}"` : '-'}</div>
          </div>
          <div class="remarks-box">
            <div class="remarks-title">Principal's Remarks</div>
            <div style="font-style: italic; color: #1e293b;">${st.principal_remarks ? `"${escapeHtml(st.principal_remarks)}"` : '-'}</div>
          </div>
        </div>

        <!-- Signatures Footer -->
        <div class="report-signatures">
          <div class="sig-box">
            <div style="height: 28px;"></div>
            <div class="sig-line"></div>
            <div class="sig-label">Guardian's Signature</div>
          </div>
          <div class="sig-box">
            <div style="height: 28px;"></div>
            <div class="sig-line"></div>
            <div class="sig-label">Class Teacher</div>
          </div>
          <div class="sig-box">
            <div style="height: 28px;"></div>
            <div class="sig-line"></div>
            <div class="sig-label">Headmaster / Principal</div>
          </div>
        </div>
      </div>
    </div>
    `;
  }).join('');

  container.innerHTML = cardsHtml;
}

// ----------------------------------------------------
// METADATA EDITOR (ATTENDANCE & REMARKS)
// ----------------------------------------------------
function openMetaEditor() {
  const examId = document.getElementById('cardExamSelect')?.value;
  const studentId = document.getElementById('cardStudentSelect')?.value;

  if (!examId) {
    notify('Please select an examination first', 'error');
    return;
  }

  if (!studentId) {
    notify('Please select a specific student from the dropdown to edit their remarks and attendance', 'info');
    return;
  }

  const studentObj = currentResultsData?.results?.find(r => r.student_id === parseInt(studentId, 10));
  if (!studentObj) {
    notify('Student data not found in compiled results', 'error');
    return;
  }

  document.getElementById('metaStudentId').value = studentObj.student_id;
  document.getElementById('metaStudentName').textContent = `#${studentObj.roll} • ${studentObj.name}`;
  document.getElementById('metaWorkingDays').value = studentObj.total_working_days ?? '';
  document.getElementById('metaPresence').value = studentObj.presence ?? '';
  document.getElementById('metaAbsent').value = studentObj.absent ?? '';
  document.getElementById('metaDiscipline').value = studentObj.manners_discipline || 'Very Good';
  document.getElementById('metaTeacherRemarks').value = studentObj.class_teacher_remarks ?? '';
  document.getElementById('metaPrincipalRemarks').value = studentObj.principal_remarks ?? '';

  showModal('metaModal');
}

async function handleSaveStudentMeta(e) {
  e.preventDefault();
  const examId = document.getElementById('cardExamSelect')?.value;
  const student_id = document.getElementById('metaStudentId')?.value;
  const total_working_days = document.getElementById('metaWorkingDays')?.value;
  const presence = document.getElementById('metaPresence')?.value;
  const absent = document.getElementById('metaAbsent')?.value;
  const manners_discipline = document.getElementById('metaDiscipline')?.value;
  const class_teacher_remarks = document.getElementById('metaTeacherRemarks')?.value.trim();
  const principal_remarks = document.getElementById('metaPrincipalRemarks')?.value.trim();

  try {
    const res = await apiClient.post(`/examinations/${examId}/student-meta`, {
      student_id,
      total_working_days,
      presence,
      absent,
      manners_discipline,
      class_teacher_remarks,
      principal_remarks
    });

    if (res && res.success) {
      notify('Student attendance and remarks updated!', 'success');
      closeModal('metaModal');
      await generateResultCards();
    } else {
      notify(res?.error || 'Failed to update metadata', 'error');
    }
  } catch (err) {
    console.error('Save meta error:', err);
    notify(err.message || 'Failed to update metadata', 'error');
  }
}

async function printAllResults() {
  const examId = document.getElementById('cardExamSelect')?.value;
  const classId = document.getElementById('cardClassSelect')?.value;

  if (!examId || !classId) {
    notify('Please select both an Examination and Class first', 'error');
    return;
  }

  const stuSel = document.getElementById('cardStudentSelect');
  // Ensure "All Students in Class" is selected so every student's card is rendered
  if (stuSel && stuSel.value !== '') {
    stuSel.value = '';
    await generateResultCards();
  } else if (!currentResultsData || !currentResultsData.results || currentResultsData.results.length === 0) {
    await generateResultCards();
  }

  setTimeout(() => {
    window.print();
  }, 100);
}

async function printSingleCard(studentId) {
  const stuSel = document.getElementById('cardStudentSelect');
  const prevVal = stuSel ? stuSel.value : '';
  if (stuSel) {
    stuSel.value = String(studentId);
    await generateResultCards();
    setTimeout(() => {
      window.print();
      // Restore all students if we were previously viewing all students
      if (prevVal === '') {
        stuSel.value = '';
        generateResultCards();
      }
    }, 100);
  }
}

window.printAllResults = printAllResults;
window.printSingleCard = printSingleCard;
window.generateResultCards = generateResultCards;
window.openMetaEditor = openMetaEditor;
window.closeModal = closeModal;
window.showModal = showModal;

// Academic Architecture & Subject Assignments Frontend Controller

let academicClasses = [];
let academicSubjects = [];
let academicAssignments = [];
let availableTeachers = [];

const apiClient = window.api || (typeof api !== 'undefined' ? api : {
  get: (url, p) => {
    let full = '/abms/api' + url;
    if (p && Object.keys(p).length) {
      const q = new URLSearchParams(p).toString();
      full += (full.includes('?') ? '&' : '?') + q;
    }
    return (window.authFetch ? window.authFetch(full) : fetch(full)).then(r => r.json());
  },
  post: (url, b) => (window.authFetch ? window.authFetch('/abms/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }) : fetch('/abms/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } })).then(r => r.json()),
  put: (url, b) => (window.authFetch ? window.authFetch('/abms/api' + url, { method: 'PUT', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }) : fetch('/abms/api' + url, { method: 'PUT', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } })).then(r => r.json()),
  delete: (url) => (window.authFetch ? window.authFetch('/abms/api' + url, { method: 'DELETE' }) : fetch('/abms/api' + url, { method: 'DELETE' })).then(r => r.json())
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

  await loadAllInitialData();
});

function switchAcademicTab(tab) {
  ['classes', 'subjects', 'assignments'].forEach(t => {
    const sec = document.getElementById('section' + t.charAt(0).toUpperCase() + t.slice(1));
    const btn = document.getElementById('tabBtn' + t.charAt(0).toUpperCase() + t.slice(1));
    if (sec) sec.style.display = (t === tab) ? 'block' : 'none';
    if (btn) {
      if (t === tab) {
        btn.classList.add('active-tab');
        btn.style.background = '#004ac6';
        btn.style.color = 'white';
      } else {
        btn.classList.remove('active-tab');
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  });

  if (tab === 'subjects') loadSubjects();
  if (tab === 'assignments') loadAssignments();
  if (tab === 'classes') loadClasses();
}

function setupEventListeners() {
  // Subjects filters
  document.getElementById('subjectStreamFilter')?.addEventListener('change', () => {
    updateClassDropdowns();
    loadSubjects();
  });
  document.getElementById('subjectClassFilter')?.addEventListener('change', loadSubjects);

  // Assignments filters
  document.getElementById('assignStreamFilter')?.addEventListener('change', () => {
    updateAssignClassDropdown();
    loadAssignments();
  });
  document.getElementById('assignClassFilter')?.addEventListener('change', loadAssignments);

  // Classes filter
  document.getElementById('classesStreamFilter')?.addEventListener('change', loadClasses);

  // Subject Modal
  document.getElementById('openAddSubjectModalBtn')?.addEventListener('click', () => {
    document.getElementById('subjectForm').reset();
    document.getElementById('subjectFormId').value = '';
    document.getElementById('subjectModalTitle').textContent = 'Add New Subject';
    updateModalClassDropdown();
    showModal('subjectModal');
  });

  document.getElementById('subjStreamInput')?.addEventListener('change', updateModalClassDropdown);
  document.getElementById('subjectForm')?.addEventListener('submit', handleSaveSubject);
  document.getElementById('assignForm')?.addEventListener('submit', handleSaveAssignment);
}

async function loadAllInitialData() {
  try {
    // 1. Load classes
    const clsRes = await apiClient.get('/academic/classes');
    if (clsRes && clsRes.success) {
      academicClasses = clsRes.data || [];
    }

    // 2. Load teachers
    const teachRes = await apiClient.get('/teachers');
    if (teachRes && teachRes.success) {
      availableTeachers = teachRes.teachers || teachRes.data || [];
    }

    updateClassDropdowns();
    updateAssignClassDropdown();
    await loadSubjects();
  } catch (err) {
    console.error('Initialization error:', err);
    notify(err.message || 'Failed to initialize academic data', 'error');
  }
}

function updateClassDropdowns() {
  const stream = document.getElementById('subjectStreamFilter')?.value || '';
  const filterCls = document.getElementById('subjectClassFilter');
  if (!filterCls) return;

  const filtered = academicClasses.filter(c => !stream || c.stream === stream);
  let html = '<option value="">All Classes</option>';
  filtered.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.stream)})</option>`;
  });
  filterCls.innerHTML = html;
}

function updateAssignClassDropdown() {
  const stream = document.getElementById('assignStreamFilter')?.value || 'General';
  const assignCls = document.getElementById('assignClassFilter');
  if (!assignCls) return;

  const filtered = academicClasses.filter(c => c.stream === stream);
  let html = '<option value="">Select Class...</option>';
  filtered.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  assignCls.innerHTML = html;
  if (filtered.length > 0) {
    assignCls.value = filtered[0].id;
  }
}

function updateModalClassDropdown() {
  const stream = document.getElementById('subjStreamInput')?.value || 'General';
  const modalCls = document.getElementById('subjClassInput');
  if (!modalCls) return;

  const filtered = academicClasses.filter(c => c.stream === stream);
  let html = '<option value="">Select Class...</option>';
  filtered.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  modalCls.innerHTML = html;
}

async function loadSubjects() {
  const tbody = document.getElementById('subjectsTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">Loading subjects...</td></tr>`;

  try {
    const stream = document.getElementById('subjectStreamFilter')?.value || '';
    const classId = document.getElementById('subjectClassFilter')?.value || '';

    const params = {};
    if (stream) params.stream = stream;
    if (classId) params.class_id = classId;

    const res = await apiClient.get('/academic/subjects', params);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load subjects');

    academicSubjects = res.data || [];
    renderSubjectsTable(academicSubjects);
  } catch (err) {
    console.error('Error loading subjects:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSubjectsTable(subjects) {
  const tbody = document.getElementById('subjectsTableBody');
  if (!tbody) return;

  if (subjects.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">No subjects found for the selected filter. Click "+ Add New Subject" above.</td></tr>`;
    return;
  }

  tbody.innerHTML = subjects.map(s => {
    const streamBadge = s.stream === 'Hifz'
      ? '<span class="rate-badge" style="background: #d1fae5; color: #065f46; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">Hifz</span>'
      : '<span class="rate-badge" style="background: #e0f2fe; color: #0369a1; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">General</span>';

    const teacherText = s.teacher_name
      ? `<span style="font-weight: 600; color: #0f172a;">${escapeHtml(s.teacher_name)}</span>`
      : `<span style="color: #94a3b8; font-style: italic;">Unassigned</span>`;

    return `
      <tr>
        <td style="font-family: monospace; font-weight: 700; color: #64748b;">${escapeHtml(s.code || '-')}</td>
        <td style="font-weight: 700; color: #004ac6;">${escapeHtml(s.name)}</td>
        <td>${streamBadge}</td>
        <td><span class="badge-tag">${escapeHtml(s.class_name || 'Class ' + s.class_id)}</span></td>
        <td style="font-weight: 600;">${s.full_marks || 100}</td>
        <td>${teacherText}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="editSubject(${s.id})" title="Edit Subject" style="padding: 0.25rem 0.5rem;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">edit</span>
          </button>
          <button class="btn btn-secondary btn-sm" onclick="deleteSubject(${s.id}, '${escapeHtml(s.name)}')" title="Delete Subject" style="padding: 0.25rem 0.5rem; color: #dc2626;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">delete</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleSaveSubject(e) {
  e.preventDefault();
  const id = document.getElementById('subjectFormId').value;
  const stream = document.getElementById('subjStreamInput').value;
  const class_id = document.getElementById('subjClassInput').value;
  const name = document.getElementById('subjNameInput').value.trim();
  const code = document.getElementById('subjCodeInput').value.trim();
  const full_marks = parseInt(document.getElementById('subjFullMarksInput').value, 10) || 100;

  if (!name || !class_id) {
    notify('Subject Name and Class are required', 'error');
    return;
  }

  try {
    let res;
    if (id) {
      res = await apiClient.put(`/academic/subjects/${id}`, { stream, class_id, name, code, full_marks });
    } else {
      res = await apiClient.post('/academic/subjects', { stream, class_id, name, code, full_marks });
    }

    if (res && res.success) {
      notify(res.message || 'Subject saved successfully!', 'success');
      closeModal('subjectModal');
      await loadSubjects();
    } else {
      notify(res?.error || 'Failed to save subject', 'error');
    }
  } catch (err) {
    console.error('Error saving subject:', err);
    notify(err.message || 'Failed to save subject', 'error');
  }
}

function editSubject(id) {
  const sub = academicSubjects.find(s => s.id === id);
  if (!sub) return;

  document.getElementById('subjectFormId').value = sub.id;
  document.getElementById('subjStreamInput').value = sub.stream || 'General';
  updateModalClassDropdown();
  document.getElementById('subjClassInput').value = sub.class_id;
  document.getElementById('subjNameInput').value = sub.name || '';
  document.getElementById('subjCodeInput').value = sub.code || '';
  document.getElementById('subjFullMarksInput').value = sub.full_marks || 100;
  document.getElementById('subjectModalTitle').textContent = 'Edit Subject';

  showModal('subjectModal');
}

async function deleteSubject(id, name) {
  if (!confirm(`Are you sure you want to deactivate or delete subject "${name}"?`)) return;

  try {
    const res = await apiClient.delete(`/academic/subjects/${id}`);
    if (res && res.success) {
      notify(res.message || 'Subject removed successfully!', 'success');
      await loadSubjects();
    } else {
      notify(res?.error || 'Failed to delete subject', 'error');
    }
  } catch (err) {
    console.error('Delete subject error:', err);
    notify(err.message || 'Failed to delete subject', 'error');
  }
}

// ----------------------------------------------------
// TEACHER ASSIGNMENTS MATRIX
// ----------------------------------------------------
async function loadAssignments() {
  const tbody = document.getElementById('assignmentsTableBody');
  if (!tbody) return;

  const stream = document.getElementById('assignStreamFilter')?.value || 'General';
  const classId = document.getElementById('assignClassFilter')?.value;

  if (!classId) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">Please select a class above to view subject assignments.</td></tr>`;
    return;
  }

  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">Loading assignments matrix...</td></tr>`;

  try {
    const res = await apiClient.get('/academic/assignments', { class_id: classId, stream });
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load assignments');

    academicAssignments = res.data || [];
    renderAssignmentsTable(academicAssignments);
  } catch (err) {
    console.error('Error loading assignments:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderAssignmentsTable(items) {
  const tbody = document.getElementById('assignmentsTableBody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">No subjects registered for this class. Go to the "Subjects" tab to add subjects first.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(a => {
    const isAssigned = !!a.teacher_id;
    return `
      <tr>
        <td style="font-weight: 700; color: #004ac6;">
          ${escapeHtml(a.subject_name)}
          ${a.subject_code ? `<span style="font-size: 0.72rem; color: #64748b; font-family: monospace;">(${escapeHtml(a.subject_code)})</span>` : ''}
        </td>
        <td>
          <span class="badge-tag">${escapeHtml(a.stream)}</span>
          <span style="font-size: 0.8rem; color: #475569; margin-left: 4px;">${escapeHtml(a.class_name)}</span>
        </td>
        <td>
          ${isAssigned ? `
            <div style="font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 0.35rem;">
              <span class="material-symbols-outlined" style="font-size: 1.1rem; color: #16a34a;">check_circle</span>
              ${escapeHtml(a.teacher_name)}
            </div>
          ` : `
            <span style="color: #dc2626; font-weight: 600; font-size: 0.8rem; background: #fee2e2; padding: 2px 6px; border-radius: 4px;">
              ⚠ Unassigned
            </span>
          `}
        </td>
        <td style="color: #475569;">${a.teacher_phone ? escapeHtml(a.teacher_phone) : '-'}</td>
        <td>
          ${a.teacher_stream ? `<span class="badge-tag">${escapeHtml(a.teacher_stream)}</span>` : '-'}
        </td>
        <td style="text-align: right;">
          <button class="btn btn-sm ${isAssigned ? 'btn-secondary' : 'btn-primary'}"
                  onclick="openAssignModal(${a.subject_id}, '${escapeHtml(a.subject_name)}', '${escapeHtml(a.class_name)}', '${a.stream}')"
                  style="font-size: 0.8rem; padding: 0.25rem 0.65rem;">
            <span class="material-symbols-outlined" style="font-size: 0.95rem;">assignment_ind</span>
            ${isAssigned ? 'Reassign Teacher' : 'Assign Teacher'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openAssignModal(subjectId, subjectName, className, stream) {
  document.getElementById('assignSubjectId').value = subjectId;
  document.getElementById('assignSubjectName').textContent = subjectName;
  document.getElementById('assignSubjectClass').textContent = `${stream} • ${className}`;

  const select = document.getElementById('assignTeacherSelect');
  if (select) {
    const eligibleTeachers = availableTeachers.filter(t => !t.stream || t.stream === stream || t.stream === 'All');
    let opts = '<option value="">Select teacher to assign...</option>';
    eligibleTeachers.forEach(t => {
      opts += `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.stream || 'General')} • ${t.phone || 'No phone'})</option>`;
    });
    select.innerHTML = opts;
  }

  showModal('assignModal');
}

async function handleSaveAssignment(e) {
  e.preventDefault();
  const subject_id = document.getElementById('assignSubjectId').value;
  const teacher_id = document.getElementById('assignTeacherSelect').value;

  if (!subject_id || !teacher_id) {
    notify('Please select a teacher to assign', 'error');
    return;
  }

  try {
    const res = await apiClient.post('/academic/assignments', {
      subject_id: parseInt(subject_id, 10),
      teacher_id: parseInt(teacher_id, 10)
    });

    if (res && res.success) {
      notify(res.message || 'Teacher assigned successfully!', 'success');
      closeModal('assignModal');
      await loadAssignments();
    } else {
      notify(res?.error || 'Failed to assign teacher', 'error');
    }
  } catch (err) {
    console.error('Assign error:', err);
    notify(err.message || 'Assignment failed', 'error');
  }
}

// ----------------------------------------------------
// CLASSES TAB
// ----------------------------------------------------
async function loadClasses() {
  const tbody = document.getElementById('classesTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #64748b;">Loading classes...</td></tr>`;

  try {
    const stream = document.getElementById('classesStreamFilter')?.value || '';
    const params = stream ? { stream } : {};

    const res = await apiClient.get('/academic/classes', params);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load classes');

    const classes = res.data || [];
    renderClassesTable(classes);
  } catch (err) {
    console.error('Error loading classes:', err);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderClassesTable(classes) {
  const tbody = document.getElementById('classesTableBody');
  if (!tbody) return;

  if (classes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #64748b;">No classes found.</td></tr>`;
    return;
  }

  tbody.innerHTML = classes.map(c => `
    <tr>
      <td style="font-weight: 700; color: #004ac6;">${escapeHtml(c.name)}</td>
      <td>
        <span class="rate-badge" style="background: ${c.stream === 'Hifz' ? '#d1fae5' : '#e0f2fe'}; color: ${c.stream === 'Hifz' ? '#065f46' : '#0369a1'}; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">
          ${escapeHtml(c.stream)}
        </span>
      </td>
      <td>#${c.class_number}</td>
      <td style="font-weight: 600;">৳${(c.monthly_fee || 0).toLocaleString()}</td>
      <td style="color: #475569;">${escapeHtml(c.class_teacher || 'Md. Rafiqul Islam')}</td>
    </tr>
  `).join('');
}

window.switchAcademicTab = switchAcademicTab;
window.editSubject = editSubject;
window.deleteSubject = deleteSubject;
window.openAssignModal = openAssignModal;
window.closeModal = closeModal;
window.showModal = showModal;

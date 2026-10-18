// Settings & Database Maintenance Frontend Logic
let classesList = [];

document.addEventListener('DOMContentLoaded', async () => {
  if (window.authReady) {
    try {
      const state = await window.authReady;
      if (state && state.role === 'super_admin') {
        const cleanRegContainer = document.getElementById('super-admin-settings-container');
        if (cleanRegContainer) cleanRegContainer.style.display = 'block';

        const restoreContainer = document.getElementById('super-admin-restore-container');
        if (restoreContainer) restoreContainer.style.display = 'block';

        const sysArchCard = document.getElementById('card-system-architecture');
        if (sysArchCard) sysArchCard.style.display = 'block';
      }
    } catch (e) { }
  }

  await loadSystemInfo();
  await loadClasses();
  await loadAcademicYears();
  setupEventListeners();
});

async function loadSystemInfo() {
  try {
    const res = await api.get('/settings/system');
    const sys = res.data;
    document.getElementById('sys-app-name').textContent = sys.appName;
    document.getElementById('sys-edition').textContent = sys.edition;
    document.getElementById('sys-runtime').textContent = sys.runtime;
    document.getElementById('sys-database').textContent = sys.database;
    document.getElementById('sys-db-size').textContent = sys.dbSize;
    document.getElementById('sys-last-sync').textContent = sys.lastModified;
  } catch (err) {
    console.error('Failed to load system info', err);
  }
}

async function loadClasses() {
  try {
    const selectedAy = getSelectedAcademicYear();
    const res = await api.get('/classes', { academic_year_id: selectedAy.id });
    classesList = res.data || [];
    renderClassesTable(classesList);
    populateDeleteClassDropdown(classesList);
  } catch (err) {
    showToast('Failed to load classes: ' + err.message, 'error');
  }
}

function populateDeleteClassDropdown(classes) {
  const select = document.getElementById('select-delete-class');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Choose a class to delete --</option>' +
    classes.map(c => `<option value="${c.id}">${c.name} (${c.student_count || 0} students • ৳${c.monthly_fee}/mo)</option>`).join('');

  if (currentVal && classes.some(c => String(c.id) === String(currentVal))) {
    select.value = currentVal;
    onSelectClassToDeleteChange();
  } else {
    select.value = '';
    onSelectClassToDeleteChange();
  }
}

function onSelectClassToDeleteChange() {
  const select = document.getElementById('select-delete-class');
  const previewCard = document.getElementById('delete-class-preview-card');
  const btn = document.getElementById('btn-trigger-delete-class');
  if (!select) return;

  const id = parseInt(select.value, 10);
  if (isNaN(id) || !id) {
    if (previewCard) previewCard.style.display = 'none';
    if (btn) btn.disabled = true;
    return;
  }

  const cls = classesList.find(c => c.id === id);
  if (!cls) {
    if (previewCard) previewCard.style.display = 'none';
    if (btn) btn.disabled = true;
    return;
  }

  const nameEl = document.getElementById('del-preview-name');
  const studentsEl = document.getElementById('del-preview-students');
  const feeEl = document.getElementById('del-preview-fee');

  if (nameEl) nameEl.textContent = `${cls.name} (Level ${cls.class_number})`;
  if (studentsEl) studentsEl.textContent = `${cls.student_count || 0} Enrolled Students`;
  if (feeEl) feeEl.textContent = `${formatCurrency(cls.monthly_fee)} / month`;

  if (previewCard) previewCard.style.display = 'block';
  if (btn) btn.disabled = false;
}

function openDeleteClassModalFromSelect() {
  const select = document.getElementById('select-delete-class');
  if (!select) return;
  const id = parseInt(select.value, 10);
  if (!id) return;
  const cls = classesList.find(c => c.id === id);
  if (!cls) return;

  const checkTotal = document.getElementById('check-delete-total-database');
  const isTotal = checkTotal ? checkTotal.checked : true;

  openConfirmDeleteClassModal(cls.id, cls.name, cls.student_count || 0, isTotal);
}

function renderClassesTable(classes) {
  const tbody = document.getElementById('classes-settings-tbody');
  if (!tbody) return;

  tbody.innerHTML = classes.map(c => `
    <tr>
      <td style="font-weight: 700; color: #004ac6;">${c.name}</td>
      <td style="font-size: 0.8rem; color: #64748b;">Class #${c.class_number}</td>
      <td>
        <span class="badge-tag">${c.student_count || 0} Students</span>
      </td>
      <td style="font-weight: 700; color: #16a34a;">${formatCurrency(c.monthly_fee)} / mo</td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="openEditClassModal(${c.id}, '${c.name.replace(/'/g, "\\'")}', ${c.monthly_fee})">
          <span class="material-symbols-outlined" style="font-size: 1rem;">edit</span>
          Edit Fee
        </button>
        <button class="btn btn-secondary btn-sm" style="color: #dc2626;" title="Delete Class" onclick="deleteClass(${c.id}, '${c.name.replace(/'/g, "\\'")}', ${c.student_count || 0})">
          <span class="material-symbols-outlined" style="font-size: 1rem;">delete</span>
          Delete
        </button>
      </td>
    </tr>
  `).join('');
}

function setupEventListeners() {
  // Add Class Form
  const formAddClass = document.getElementById('form-add-class');
  if (formAddClass) {
    formAddClass.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await api.post('/classes', {
          name: form.class_name.value,
          class_number: form.class_number.value,
          monthly_fee: form.monthly_fee.value
        });
        showToast('New class created successfully', 'success');
        closeModal('modal-add-class-dialog');
        form.reset();
        await loadClasses();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Edit Class Form
  const formEditClass = document.getElementById('form-edit-class');
  if (formEditClass) {
    formEditClass.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.class_id.value;
      try {
        await api.put(`/classes/${id}`, {
          name: form.class_name.value,
          monthly_fee: form.monthly_fee.value
        });
        showToast('Class fee updated successfully', 'success');
        closeModal('modal-edit-class-dialog');
        await loadClasses();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

function downloadDatabaseBackup() {
  window.location.href = '/api/backup';
  showToast('Database backup download initiated', 'success');
}

async function triggerDatabaseReseed() {
  if (!confirm('Are you sure you want to reset and re-seed the SQLite database with realistic default records? Current changes will be replaced.')) {
    return;
  }

  try {
    const res = await api.post('/seed', {});
    showToast(res.message, 'success');
    await loadSystemInfo();
    await loadClasses();
    await loadAcademicYears();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function clearOperationalData() {
  if (!confirm('This will permanently delete ALL students, payments, and expenses. Classes and academic year settings will stay. Continue?')) {
    return;
  }
  try {
    const res = await api.post('/reset-operational', {});
    showToast(res.message, 'success');
    await loadSystemInfo();
    await loadClasses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadAcademicYears() {
  const box = document.getElementById('academic-years-list');
  if (!box) return;
  try {
    const res = await api.get('/academic-years');
    const years = res.data || [];
    if (years.length === 0) {
      box.textContent = 'No academic years found.';
      return;
    }

    const activeYear = years.find(y => y.is_active) || years[0];
    const activeBadge = document.getElementById('settings-active-ay-badge');
    if (activeBadge) {
      activeBadge.textContent = `AY ${activeYear.year} Active`;
    }

    const newYearInput = document.getElementById('new-academic-year-input');
    if (newYearInput && (!newYearInput.value || newYearInput.value === '2027')) {
      newYearInput.value = activeYear.year + 1;
    }

    box.innerHTML = years.map(y => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.45rem 0; border-bottom: 1px solid #dbeafe;">
        <span style="font-weight: 600;">
          ${y.name || 'Academic Year ' + y.year}
          ${y.is_active ? '<span class="badge-tag" style="background:#dcfce7;color:#15803d;margin-left:6px;">● Active</span>' : ''}
        </span>
        <div style="display: flex; gap: 0.35rem; align-items: center;">
          ${y.is_active ? '' : `<button class="btn btn-secondary btn-sm" onclick="activateAcademicYear(${y.id})">Activate</button>`}
          ${y.is_active ? '' : `<button class="btn btn-secondary btn-sm" style="color: #dc2626;" title="Delete Academic Year" onclick="deleteAcademicYear(${y.id}, ${y.year})"><span class="material-symbols-outlined" style="font-size: 1rem;">delete</span></button>`}
        </div>
      </div>
    `).join('');
  } catch (err) {
    box.textContent = 'Could not load academic years.';
  }
}

async function createAcademicYear() {
  const input = document.getElementById('new-academic-year-input');
  const year = parseInt(input && input.value ? input.value : '', 10);
  if (!year) {
    showToast('Enter a valid year', 'error');
    return;
  }
  try {
    const res = await api.post('/academic-years', {
      year,
      name: `Academic Year ${year}`,
      start_date: `${year}-01-01`,
      end_date: `${year}-12-31`
    });
    showToast(res.message || `Academic Year ${year} created. Activate it to start enrolling students.`, 'success');
    await loadAcademicYearContext();
    await loadAcademicYears();
    await loadClasses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function activateAcademicYear(id) {
  try {
    const res = await api.post(`/academic-years/${id}/activate`, {});
    showToast(res.message || 'Academic year activated', 'success');
    await loadAcademicYearContext();
    await loadAcademicYears();
    await loadClasses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteAcademicYear(id, year) {
  if (!confirm(`Are you sure you want to permanently delete Academic Year ${year} and all its classes, student rosters, and ledgers? This action cannot be undone.`)) {
    return;
  }
  try {
    const res = await api.delete(`/academic-years/${id}`);
    showToast(res.message || `Academic Year ${year} deleted successfully`, 'success');
    await loadAcademicYearContext();
    await loadAcademicYears();
    await loadClasses();
  } catch (err) {
    showToast('Failed to delete academic year: ' + err.message, 'error');
  }
}

function openEditClassModal(id, name, fee) {
  const form = document.getElementById('form-edit-class');
  form.class_id.value = id;
  form.class_name.value = name;
  form.monthly_fee.value = fee;
  openModal('modal-edit-class-dialog');
}

function handleDeleteFromEditClassModal() {
  const form = document.getElementById('form-edit-class');
  const id = parseInt(form.class_id.value, 10);
  const name = form.class_name.value;
  const targetClass = classesList.find(c => c.id === id);
  const studentCount = targetClass ? (targetClass.student_count || 0) : 0;
  closeModal('modal-edit-class-dialog');
  openConfirmDeleteClassModal(id, name, studentCount, true);
}

function openConfirmDeleteClassModal(id, name, studentCount, isTotalDefault = true) {
  const idInput = document.getElementById('confirm-delete-class-id');
  const nameEl = document.getElementById('confirm-delete-class-name');
  const countEl = document.getElementById('confirm-delete-student-count');

  if (idInput) idInput.value = id;
  if (nameEl) nameEl.textContent = name;
  if (countEl) countEl.textContent = `${studentCount} enrolled student(s)`;

  const scopeTotal = document.getElementById('scope-total-database');
  const scopeActive = document.getElementById('scope-active-year');
  if (isTotalDefault) {
    if (scopeTotal) scopeTotal.checked = true;
  } else {
    if (scopeActive) scopeActive.checked = true;
  }

  openModal('modal-confirm-delete-class');
}

function deleteClass(id, name, studentCount) {
  openConfirmDeleteClassModal(id, name, studentCount, true);
}

async function executeDeleteClass() {
  const idInput = document.getElementById('confirm-delete-class-id');
  const id = parseInt(idInput.value, 10);
  if (!id) return;

  const scopeRadios = document.getElementsByName('modal-delete-scope');
  let scope = 'total';
  for (const r of scopeRadios) {
    if (r.checked) {
      scope = r.value;
      break;
    }
  }

  const btn = document.getElementById('btn-execute-delete-class');
  const btnText = document.getElementById('btn-execute-delete-class-text');
  const originalText = btnText ? btnText.textContent : 'Yes, Delete Class From Database';

  try {
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Deleting from database...';

    const isTotal = (scope === 'total');
    const res = await api.delete(`/classes/${id}?total_database=${isTotal}`);

    closeModal('modal-confirm-delete-class');
    showToast(res.message || 'Class deleted permanently from the database', 'success');

    // Reload classes and system info
    await loadClasses();
    await loadSystemInfo();
  } catch (err) {
    showToast('Failed to delete class: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = originalText;
  }
}

async function uploadAndRestoreDatabase() {
  const fileInput = document.getElementById('restore-db-file-input');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('Please select a valid SQLite database file first.', 'error');
    return;
  }

  const file = fileInput.files[0];
  if (!confirm(`Are you sure you want to restore the database from "${file.name}"? An automatic backup of your current database will be created before replacing.`)) {
    return;
  }

  const formData = new FormData();
  formData.append('database_file', file);

  try {
    showToast('Uploading and restoring database...', 'info');
    const token = typeof window.auth !== 'undefined' && window.auth.getAccessToken ? window.auth.getAccessToken() : '';
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/abms/api/database/restore', {
      method: 'POST',
      headers,
      body: formData
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
      throw new Error(body.message || body.error || 'Database restore failed');
    }

    showToast(body.message || 'Database restored successfully!', 'success');
    fileInput.value = '';

    // Reload system info, classes, and academic years
    await loadSystemInfo();
    await loadClasses();
    await loadAcademicYears();
  } catch (err) {
    showToast('Failed to restore database: ' + err.message, 'error');
  }
}

window.uploadAndRestoreDatabase = uploadAndRestoreDatabase;
window.openEditClassModal = openEditClassModal;
window.handleDeleteFromEditClassModal = handleDeleteFromEditClassModal;
window.deleteClass = deleteClass;
window.openConfirmDeleteClassModal = openConfirmDeleteClassModal;
window.openDeleteClassModalFromSelect = openDeleteClassModalFromSelect;
window.onSelectClassToDeleteChange = onSelectClassToDeleteChange;
window.executeDeleteClass = executeDeleteClass;
window.createAcademicYear = createAcademicYear;
window.activateAcademicYear = activateAcademicYear;
window.deleteAcademicYear = deleteAcademicYear;
window.triggerDatabaseReseed = triggerDatabaseReseed;
window.clearOperationalData = clearOperationalData;
window.downloadDatabaseBackup = downloadDatabaseBackup;

// Students Page Frontend Logic
let allStudents = [];
let allClasses = [];

document.addEventListener('DOMContentLoaded', async () => {
  await loadClasses();
  readUrlParams();

  // Update dynamic month labels in the UI
  const curMonthName = getCurrentMonthName();
  const curShortMonth = curMonthName.substring(0, 3).toUpperCase();
  const realizedLabel = document.getElementById('stat-fee-realized-label');
  if (realizedLabel) realizedLabel.textContent = `${curShortMonth} FEE REALIZED`;
  const duesLabel = document.getElementById('stat-outstanding-dues-label');
  if (duesLabel) duesLabel.textContent = `OUTSTANDING DUES (${curMonthName})`;
  const duesSub = document.getElementById('stat-dues-sub');
  if (duesSub) duesSub.textContent = `Pending ${curMonthName} payments`;
  const paidOpt = document.getElementById('filter-option-paid');
  if (paidOpt) paidOpt.textContent = `Paid (${curShortMonth})`;
  const dueOpt = document.getElementById('filter-option-due');
  if (dueOpt) dueOpt.textContent = `Due (${curShortMonth})`;
  const tableHeader = document.getElementById('table-header-fee-month');
  if (tableHeader) tableHeader.textContent = `${curShortMonth} Fee`;

  await loadStudents();
  setupEventListeners();

  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('edit_id');
  if (editId) {
    const parsedId = parseInt(editId, 10);
    if (!isNaN(parsedId)) {
      openEditStudentModal(parsedId);
    }
  }
});

function readUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const searchParam = urlParams.get('search');
  if (searchParam) {
    document.getElementById('filter-search-input').value = searchParam;
  }
  const classParam = urlParams.get('class_id');
  if (classParam) {
    document.getElementById('filter-class-select').value = classParam;
  }
}

async function loadClasses() {
  try {
    const res = await api.get('/classes');
    allClasses = res.data;

    // Filter class select
    const filterCls = document.getElementById('filter-class-select');
    if (filterCls) {
      filterCls.innerHTML = `
        <option value="">All Classes</option>
        ${allClasses.map(c => `<option value="${c.id}">${c.name} (৳${c.monthly_fee})</option>`).join('')}
      `;
    }

    // Modal class select
    const modalCls = document.getElementById('modal-student-class-select');
    if (modalCls) {
      modalCls.innerHTML = allClasses.map(c => `
        <option value="${c.id}">${c.name} (৳${c.monthly_fee}/mo)</option>
      `).join('');
      updateNextRollPreview();
    }

    // Payment modal class filter
    const stuPayClass = document.getElementById('stu-pay-filter-class');
    if (stuPayClass) {
      stuPayClass.innerHTML = `
        <option value="">All Classes</option>
        ${allClasses.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      `;
    }
  } catch (err) {
    console.error('Failed to load classes', err);
  }
}

async function loadStudents() {
  const search = document.getElementById('filter-search-input').value.trim();
  const classId = document.getElementById('filter-class-select').value;
  const stream = document.getElementById('filter-stream-select')?.value || '';
  const paymentStatus = document.getElementById('filter-payment-select').value;

  try {
    const params = {
      search,
      class_id: classId,
      payment_status: paymentStatus,
      month: getCurrentMonthName()
    };
    if (stream) params.stream = stream;

    const res = await api.get('/students', params);

    allStudents = res.data;
    renderStats(allStudents);
    renderStudentsTable(allStudents);
  } catch (err) {
    showToast('Failed to load students: ' + err.message, 'error');
  }
}

function renderStats(students) {
  const total = students.length;

  let realized = 0;
  let dues = 0;

  students.forEach(s => {
    if (s.current_month_status === 'Paid') {
      realized += s.monthly_fee;
    } else {
      dues += s.monthly_fee;
    }
  });

  document.getElementById('stat-total-students').textContent = `${total} Students`;
  document.getElementById('stat-active-students').textContent = `5 Classes`;
  document.getElementById('stat-realized-fee').textContent = formatCurrency(realized);
  document.getElementById('stat-dues-fee').textContent = formatCurrency(dues);
  document.getElementById('student-count-badge').textContent = `${total} Enrolled`;
}

function renderStudentsTable(students) {
  const tbody = document.getElementById('students-tbody');
  if (!tbody) return;

  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 2rem;">No students found matching your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = students.map(st => {
    const isPaid = st.current_month_status === 'Paid';
    const initials = st.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
    const streamBadge = st.stream === 'Hifz'
      ? '<span class="rate-badge" style="background: #d1fae5; color: #065f46; font-size: 0.7rem; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 4px;">Hifz</span>'
      : '<span class="rate-badge" style="background: #e0f2fe; color: #0369a1; font-size: 0.7rem; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 4px;">General</span>';

    return `
      <tr>
        <td style="font-weight: 700; color: #004ac6; white-space: nowrap;">
          <a href="student-details.html?id=${st.id}" style="color: inherit; text-decoration: none;">
            #${st.roll_number}
          </a>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.65rem;">
            ${st.photo_url ? `
              <img src="${st.photo_url}" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover;" referrerpolicy="no-referrer">
            ` : `
              <div class="student-row-avatar">${initials}</div>
            `}
            <div>
              <a href="student-details.html?id=${st.id}" style="font-weight: 600; color: var(--on-surface); text-decoration: none;">
                ${st.name}
              </a>
              <div style="font-size: 0.72rem; color: #64748b;">
                ${st.father_name && st.father_name !== 'N/A' ? `F: ${st.father_name}` : ''}
                ${st.mother_name && st.mother_name !== 'N/A' ? ` • M: ${st.mother_name}` : ''}
              </div>
            </div>
          </div>
        </td>
        <td style="color: #334155; white-space: nowrap;">
          <div>${st.phone || '<span style="color:#94a3b8;">N/A</span>'} ${st.primary_contact === 'primary' && st.phone_secondary ? '<span style="font-size:0.65rem; color:#0284c7;">(P)</span>' : ''}</div>
          ${st.phone_secondary ? `<div style="font-size: 0.72rem; color: #64748b;">${st.phone_secondary} ${st.primary_contact === 'secondary' ? '<span style="font-size:0.65rem; color:#0284c7;">(P)</span>' : ''}</div>` : ''}
        </td>
        <td>
          <span class="badge-tag">${st.class_name}</span>
          ${streamBadge}
        </td>
        <td style="font-weight: 600;">${formatCurrency(st.monthly_fee)}</td>
        <td style="color: #64748b; font-size: 0.8rem; white-space: nowrap;">${formatDate(st.admission_date)}</td>
        <td>
          <span class="status-pill ${isPaid ? 'paid' : 'due'}">
            ${isPaid ? '● Paid ✓' : '● Due'}
          </span>
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <a href="student-details.html?id=${st.id}" class="btn btn-secondary btn-sm" title="View Dossier" style="padding: 0.35rem 0.55rem;">
            <span class="material-symbols-outlined" style="font-size: 1rem;">visibility</span>
          </a>
          <button class="btn btn-secondary btn-sm" title="Edit Student" style="padding: 0.35rem 0.55rem;" onclick="openEditStudentModal(${st.id})">
            <span class="material-symbols-outlined" style="font-size: 1rem;">edit</span>
          </button>
          <button class="btn btn-secondary btn-sm" title="Delete Student" style="padding: 0.35rem 0.55rem; color: #dc2626;" onclick="deleteStudent(${st.id}, '${st.name.replace(/'/g, "\\'")}', ${st.roll_number})">
            <span class="material-symbols-outlined" style="font-size: 1rem;">delete</span>
          </button>
          ${!isPaid ? `
            <button class="btn btn-primary btn-sm" style="padding: 0.35rem 0.65rem;" onclick="quickPayStudent(${st.id}, '${st.name.replace(/'/g, "\\'")}', ${st.roll_number}, ${st.monthly_fee})">
              Collect
            </button>
          ` : `
            <button class="btn btn-outline btn-sm" style="padding: 0.35rem 0.65rem;" onclick="viewLatestReceipt(${st.id}, '${st.name.replace(/'/g, "\\'")}', ${st.roll_number}, ${st.monthly_fee})">
              Receipt
            </button>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

function setupEventListeners() {
  document.getElementById('filter-search-input').addEventListener('input', debounce(loadStudents, 300));
  document.getElementById('filter-class-select').addEventListener('change', loadStudents);
  const streamFilter = document.getElementById('filter-stream-select');
  if (streamFilter) streamFilter.addEventListener('change', loadStudents);
  document.getElementById('filter-payment-select').addEventListener('change', loadStudents);

  const modalClass = document.getElementById('modal-student-class-select');
  if (modalClass) {
    modalClass.addEventListener('change', updateNextRollPreview);
  }
  const modalStream = document.getElementById('modal-student-stream-select');
  if (modalStream) {
    modalStream.addEventListener('change', updateNextRollPreview);
  }

  const formAdd = document.getElementById('form-add-student-modal');
  if (formAdd) {
    formAdd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const res = await api.post('/students', {
          name: form.name.value,
          father_name: form.father_name.value,
          mother_name: form.mother_name.value,
          phone: form.phone.value,
          phone_secondary: form.phone_secondary ? form.phone_secondary.value : '',
          primary_contact: form.primary_contact ? form.primary_contact.value : 'primary',
          notes: form.notes ? form.notes.value : '',
          address: form.address.value,
          class_id: form.class_id.value,
          stream: form.stream ? form.stream.value : 'General',
          admission_date: form.admission_date.value || today
        });
        showToast(`Student admitted successfully with Roll #${res.data.roll_number}!`, 'success');
        closeModal('modal-add-student-dialog');
        form.reset();
        await loadStudents();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const formEdit = document.getElementById('form-edit-student-modal');
  if (formEdit) {
    formEdit.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.student_id.value;
      try {
        await api.put(`/students/${id}`, {
          name: form.name.value,
          father_name: form.father_name.value,
          mother_name: form.mother_name.value,
          phone: form.phone.value,
          phone_secondary: form.phone_secondary ? form.phone_secondary.value : '',
          primary_contact: form.primary_contact ? form.primary_contact.value : 'primary',
          notes: form.notes ? form.notes.value : '',
          address: form.address.value,
          stream: form.stream ? form.stream.value : 'General',
          admission_date: form.admission_date.value
        });
        showToast('Student profile updated successfully', 'success');
        closeModal('modal-edit-student-dialog');
        await loadStudents();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Record payment form
  const formPay = document.getElementById('form-collect-fee-modal');
  if (formPay) {
    formPay.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const res = await api.post('/payments', {
          student_id: form.student_id.value,
          month: form.month.value,
          amount: form.amount ? form.amount.value : undefined,
          payment_method: form.payment_method.value,
          note: form.note.value,
          payment_date: form.payment_date.value || today
        });
        showToast(res.message, 'success');
        closeModal('modal-collect-fee-dialog');
        await loadStudents();
        openPrintReceiptModal(res.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Setup Students Page Payment Modal
  setupStudentsPaymentModal();
}

async function updateNextRollPreview() {
  const classSelect = document.getElementById('modal-student-class-select');
  if (!classSelect || !classSelect.value) return;
  const streamSelect = document.getElementById('modal-student-stream-select');
  const stream = streamSelect ? streamSelect.value : 'General';

  try {
    const res = await api.get('/students/next-roll', { class_id: classSelect.value, stream });
    document.getElementById('next-roll-badge').textContent = `Next Roll: #${res.nextRoll}`;
    document.getElementById('next-fee-badge').textContent = `Class Fee: ৳${res.classFee}/mo`;
  } catch (err) {
    console.error(err);
  }
}

async function openEditStudentModal(id) {
  try {
    const res = await api.get(`/students/${id}`);
    const st = res.data.student;
    const form = document.getElementById('form-edit-student-modal');
    form.student_id.value = st.id;
    form.roll_number.value = `#${st.roll_number}`;
    form.class_name.value = st.class_name;
    if (form.stream) form.stream.value = st.stream || 'General';
    if (form.primary_contact) form.primary_contact.value = st.primary_contact || 'primary';
    form.name.value = st.name || '';
    form.father_name.value = (st.father_name && st.father_name !== 'N/A' && st.father_name !== 'null') ? st.father_name : '';
    form.mother_name.value = (st.mother_name && st.mother_name !== 'N/A' && st.mother_name !== 'null') ? st.mother_name : '';
    form.phone.value = st.phone || '';
    if (form.phone_secondary) form.phone_secondary.value = st.phone_secondary || '';
    form.address.value = (st.address && st.address !== 'N/A' && st.address !== 'null') ? st.address : '';
    form.admission_date.value = st.admission_date || '';
    if (form.notes) form.notes.value = st.notes || '';

    openModal('modal-edit-student-dialog');
  } catch (err) {
    showToast('Failed to load student details: ' + err.message, 'error');
  }
}

function quickPayStudent(id, name, roll, fee) {
  const form = document.getElementById('form-collect-fee-modal');
  form.student_id.value = id;
  form.student_display.value = `#${roll} - ${name}`;
  form.amount.value = fee;
  const monthSelect = form.querySelector('select[name="month"]');
  if (monthSelect) {
    monthSelect.value = getCurrentMonthName();
  } else {
    form.month.value = getCurrentMonthName();
  }
  openModal('modal-collect-fee-dialog');
}

async function viewLatestReceipt(id, name, roll, fee) {
  try {
    const res = await api.get(`/students/${id}`);
    const payments = res.data.payments;
    if (payments && payments.length > 0) {
      openPrintReceiptModal({
        ...payments[0],
        student_name: name,
        roll_number: roll,
        class_name: res.data.student.class_name
      });
    } else {
      showToast('No payment receipts recorded yet for this student', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportStudentsToExcel() {
  if (!allStudents || allStudents.length === 0) {
    showToast('No students to export', 'error');
    return;
  }

  const headers = ['Roll', 'Student Name', 'Father Name', 'Mother Name', 'Phone', 'Class', 'Monthly Fee', 'Admission Date', 'Sep Status', 'Status'];
  const csvRows = [headers.join(',')];

  allStudents.forEach(s => {
    const row = [
      s.roll_number,
      `"${s.name.replace(/"/g, '""')}"`,
      `"${(s.father_name || '').replace(/"/g, '""')}"`,
      `"${(s.mother_name || '').replace(/"/g, '""')}"`,
      `"${s.phone}"`,
      `"${s.class_name}"`,
      s.monthly_fee,
      formatDate(s.admission_date),
      s.current_month_status,
      s.status
    ];
    csvRows.push(row.join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const todayIso = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  link.download = `students-register-2026-${todayIso}.csv`;
  link.click();
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

async function deleteStudent(id, name, roll) {
  if (!confirm(`Are you sure you want to delete student "${name}" (Roll #${roll})?\n\nThis will permanently remove the student dossier and all associated fee records.`)) {
    return;
  }

  try {
    const res = await api.delete(`/students/${id}`);
    showToast(res.message || 'Student deleted successfully', 'success');
    await loadStudents();
  } catch (err) {
    showToast('Failed to delete student: ' + err.message, 'error');
  }
}

// Students Page Record Payment Modal Logic
let selectedStuPaymentStudent = null;

function setupStudentsPaymentModal() {
  const input = document.getElementById('stu-pay-student-input');
  const btnFind = document.getElementById('btn-find-student-stu');
  const filterClass = document.getElementById('stu-pay-filter-class');
  const monthSelect = document.getElementById('stu-pay-month-select');
  const btnReset = document.getElementById('btn-reset-verified-stu');
  const form = document.getElementById('form-stu-record-payment');

  if (input) {
    input.addEventListener('input', debounce(() => lookupStuStudents(false), 250));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupStuStudents(true);
      }
    });
  }

  if (btnFind) {
    btnFind.addEventListener('click', () => lookupStuStudents(true));
  }

  if (filterClass) {
    filterClass.addEventListener('change', () => {
      lookupStuStudents(false);
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', resetStuPaymentModal);
  }

  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      if (selectedStuPaymentStudent) {
        updateStuPaymentStatusBanner(selectedStuPaymentStudent, monthSelect.value);
      }
    });
  }

  if (form) {
    form.addEventListener('submit', handleStuRecordPayment);
  }
}

async function lookupStuStudents(autoSelectIfSingle = false) {
  const input = document.getElementById('stu-pay-student-input');
  const filterClass = document.getElementById('stu-pay-filter-class');
  const suggestionsBox = document.getElementById('stu-pay-student-suggestions');
  const monthSelect = document.getElementById('stu-pay-month-select');

  if (!input) return;
  const query = input.value.trim();
  const classId = filterClass ? filterClass.value : '';
  const month = monthSelect ? monthSelect.value : getCurrentMonthName();

  if (!query && !classId) {
    if (suggestionsBox) suggestionsBox.style.display = 'none';
    return;
  }

  try {
    const res = await api.get('/students/lookup', { query, class_id: classId, month });
    const students = res.students || [];

    if (autoSelectIfSingle && res.exactMatch) {
      selectStuStudentForPayment(res.exactMatch);
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      return;
    }

    if (autoSelectIfSingle && students.length === 1) {
      selectStuStudentForPayment(students[0]);
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      return;
    }

    if (students.length === 0) {
      if (suggestionsBox) {
        suggestionsBox.innerHTML = `
          <div style="padding: 0.75rem 1rem; color: #dc2626; font-size: 0.8rem; display: flex; align-items: center; gap: 0.4rem;">
            <span class="material-symbols-outlined" style="font-size: 1rem;">person_off</span>
            No student found matching "${query}"${classId ? ' in this class' : ''}.
          </div>
        `;
        suggestionsBox.style.display = 'block';
      }
      return;
    }

    if (suggestionsBox) {
      suggestionsBox.innerHTML = students.map(s => `
        <div class="stu-student-item" 
             data-id="${s.id}" 
             style="padding: 0.55rem 0.85rem; border-bottom: 1px solid #f1f5f9; cursor: pointer; display: flex; align-items: center; justify-content: space-between; transition: background 0.15s ease;">
          <div>
            <div style="font-weight: 600; font-size: 0.85rem; color: #1e293b; display: flex; align-items: center; gap: 0.4rem;">
              <span>${s.name}</span>
              <span class="badge-tag" style="font-size: 0.7rem; padding: 1px 6px;">${s.class_name}</span>
              <span class="badge-tag" style="font-size: 0.7rem; padding: 1px 6px; background: #e0f2fe; color: #0369a1;">Roll #${s.roll_number}</span>
            </div>
            <div style="font-size: 0.73rem; color: #64748b; margin-top: 1px;">
              Guardian: ${s.father_name || 'N/A'} • Phone: ${s.phone || 'N/A'}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 700; font-size: 0.82rem; color: #004ac6;">৳${s.monthly_fee}</div>
            <span style="font-size: 0.68rem; color: ${s.current_month_status === 'Paid' ? '#16a34a' : '#d97706'}; font-weight: 600;">
              ${s.current_month_status}
            </span>
          </div>
        </div>
      `).join('');

      suggestionsBox.querySelectorAll('.stu-student-item').forEach(item => {
        item.addEventListener('click', () => {
          const stId = parseInt(item.dataset.id, 10);
          const st = students.find(x => x.id === stId);
          if (st) {
            selectStuStudentForPayment(st);
            suggestionsBox.style.display = 'none';
          }
        });
      });

      suggestionsBox.style.display = 'block';
    }
  } catch (err) {
    console.error('Error looking up student:', err);
  }
}

function selectStuStudentForPayment(student) {
  selectedStuPaymentStudent = student;

  const hiddenId = document.getElementById('stu-pay-student-id');
  if (hiddenId) hiddenId.value = student.id;

  const amountInput = document.getElementById('stu-pay-amount-input');
  if (amountInput) amountInput.value = student.monthly_fee || 1000;

  const verifiedCard = document.getElementById('stu-pay-verified-student');
  const avatar = document.getElementById('stu-verified-avatar');
  const name = document.getElementById('stu-verified-name');
  const cls = document.getElementById('stu-verified-class');
  const roll = document.getElementById('stu-verified-roll');
  const phone = document.getElementById('stu-verified-phone');
  const father = document.getElementById('stu-verified-father');
  const fee = document.getElementById('stu-verified-fee');
  const searchPrompt = document.getElementById('stu-pay-search-prompt');
  const suggestionsBox = document.getElementById('stu-pay-student-suggestions');

  if (avatar) avatar.textContent = student.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  if (name) name.textContent = student.name;
  if (cls) cls.textContent = student.class_name;
  if (roll) roll.textContent = `Roll #${student.roll_number}`;
  if (phone) phone.textContent = student.phone || 'N/A';
  if (father) father.textContent = student.father_name || 'Guardian';
  if (fee) fee.textContent = formatCurrency(student.monthly_fee);

  if (verifiedCard) verifiedCard.style.display = 'block';
  if (searchPrompt) searchPrompt.style.display = 'none';
  if (suggestionsBox) suggestionsBox.style.display = 'none';

  const detailsSection = document.getElementById('stu-payment-details-section');
  if (detailsSection) {
    detailsSection.style.opacity = '1';
    detailsSection.style.pointerEvents = 'auto';
  }

  const btnSubmit = document.getElementById('btn-submit-stu-payment');
  if (btnSubmit) btnSubmit.removeAttribute('disabled');

  const monthSelect = document.getElementById('stu-pay-month-select');
  if (monthSelect && !monthSelect.dataset.initialized) {
    monthSelect.value = getCurrentMonthName();
    monthSelect.dataset.initialized = '1';
  }
  updateStuPaymentStatusBanner(student, monthSelect ? monthSelect.value : getCurrentMonthName());
}

function resetStuPaymentModal() {
  selectedStuPaymentStudent = null;
  const hiddenId = document.getElementById('stu-pay-student-id');
  if (hiddenId) hiddenId.value = '';

  const input = document.getElementById('stu-pay-student-input');
  if (input) {
    input.value = '';
    input.focus();
  }

  const verifiedCard = document.getElementById('stu-pay-verified-student');
  if (verifiedCard) verifiedCard.style.display = 'none';

  const searchPrompt = document.getElementById('stu-pay-search-prompt');
  if (searchPrompt) searchPrompt.style.display = 'flex';

  const detailsSection = document.getElementById('stu-payment-details-section');
  if (detailsSection) {
    detailsSection.style.opacity = '0.45';
    detailsSection.style.pointerEvents = 'none';
  }

  const btnSubmit = document.getElementById('btn-submit-stu-payment');
  if (btnSubmit) btnSubmit.setAttribute('disabled', 'true');
}

async function updateStuPaymentStatusBanner(student, month) {
  const banner = document.getElementById('stu-verified-status-banner');
  if (!banner) return;

  try {
    const res = await api.get('/students/lookup', { query: String(student.roll_number), class_id: student.class_id, month });
    const match = res.exactMatch || (res.students && res.students.find(s => s.id === student.id));

    if (match && match.current_month_status === 'Paid') {
      banner.style.display = 'block';
      banner.style.background = '#fef2f2';
      banner.style.border = '1px solid #fecaca';
      banner.style.color = '#b91c1c';
      banner.innerHTML = `
        <strong>⚠️ Note:</strong> ${month} tuition fee has <strong>ALREADY BEEN PAID</strong> for this student (Receipt #${match.payment?.receipt_no || 'Issued'}).
      `;
    } else {
      banner.style.display = 'block';
      banner.style.background = '#f0fdf4';
      banner.style.border = '1px solid #bbf7d0';
      banner.style.color = '#15803d';
      banner.innerHTML = `
        <strong>✓ Verified:</strong> ${month} tuition fee is currently <strong>DUE (৳${student.monthly_fee})</strong>. Ready to collect fee.
      `;
    }
  } catch (err) {
    banner.style.display = 'none';
  }
}

async function handleStuRecordPayment(e) {
  e.preventDefault();
  const form = e.target;
  const studentId = form.student_id.value;

  if (!studentId) {
    showToast('Please locate and select a verified student first', 'error');
    return;
  }

  const payload = {
    student_id: studentId,
    month: form.month.value,
    amount: form.amount.value,
    payment_method: form.payment_method.value,
    payment_date: form.payment_date.value || today,
    note: form.note.value
  };

  try {
    const res = await api.post('/payments', payload);
    showToast(`Payment collected successfully! Receipt #${res.data.receipt_no}`, 'success');
    closeModal('modal-students-record-payment');
    form.reset();
    resetStuPaymentModal();
    await loadStudents();
    openPrintReceiptModal(res.data);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const apiClient = window.api || (typeof api !== 'undefined' ? api : null);

  // State
  let teachersList = [];
  let availableSubjects = [];
  let selectedTeacherForPay = null;

  // DOM Elements - Tables & Badges
  const teachersTableBody = document.getElementById('teachersTableBody');
  const paymentHistoryTableBody = document.getElementById('paymentHistoryTableBody');
  const teacherCountBadge = document.getElementById('teacherCountBadge');

  // DOM Elements - Top KPIs
  const kpiTotalTeachers = document.getElementById('kpiTotalTeachers');
  const kpiMonthlyCommitment = document.getElementById('kpiMonthlyCommitment');
  const kpiOutstandingAdvances = document.getElementById('kpiOutstandingAdvances');
  const kpiMonthPayment = document.getElementById('kpiMonthPayment');

  // DOM Elements - Filters
  const teacherSearchInput = document.getElementById('teacherSearchInput');
  const teacherStreamFilter = document.getElementById('teacherStreamFilter');
  const paymentLogMonthInput = document.getElementById('paymentLogMonthInput');
  const globalSearchInput = document.getElementById('globalSearchInput');

  // Modals
  const teacherModal = document.getElementById('teacherModal');
  const teacherAdvanceModal = document.getElementById('teacherAdvanceModal');
  const payFixedSalaryModal = document.getElementById('payFixedSalaryModal');
  const teacherDetailModal = document.getElementById('teacherDetailModal');

  // Forms
  const teacherForm = document.getElementById('teacherForm');
  const teacherAdvanceForm = document.getElementById('teacherAdvanceForm');
  const payFixedSalaryForm = document.getElementById('payFixedSalaryForm');

  // Date Helpers
  function getTodayDhakaDate() {
    if (typeof window.getLocalIsoDate === 'function') {
      return window.getLocalIsoDate();
    }
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  }

  const todayStr = getTodayDhakaDate();
  const currentMonthStr = todayStr.substring(0, 7);

  const topbarDate = document.getElementById('topbarDate');
  if (topbarDate) {
    const d = new Date();
    const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka' };
    topbarDate.textContent = d.toLocaleDateString('en-GB', options);
  }

  if (paymentLogMonthInput) {
    paymentLogMonthInput.value = currentMonthStr;
  }

  // Modal Helpers
  function showModal(id) {
    if (typeof window.openModal === 'function') {
      window.openModal(id);
    } else {
      const m = document.getElementById(id);
      if (m) {
        m.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
    }
  }

  function hideModal(id) {
    if (typeof window.closeModal === 'function') {
      window.closeModal(id);
    } else {
      const m = document.getElementById(id);
      if (m) {
        m.classList.remove('open');
        document.body.style.overflow = '';
      }
    }
  }

  // Close modals on backdrop click
  [teacherModal, teacherAdvanceModal, payFixedSalaryModal, teacherDetailModal].forEach(modalEl => {
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) hideModal(modalEl.id);
      });
    }
  });

  // Tab Switching
  document.querySelectorAll('.teachers-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.teachers-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      const targetContent = document.getElementById(tabId);
      if (targetContent) targetContent.classList.add('active');
      if (tabId === 'paymentHistoryTab') loadPaymentHistory();
    });
  });

  // ----------------------------------------------------
  // DATA LOADING
  // ----------------------------------------------------
  async function loadTeachers() {
    try {
      teachersTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">Loading faculty records...</td></tr>';
      const res = await apiClient.get('/teachers');
      if (!res || !res.success) throw new Error(res?.error || 'Failed to load teachers');

      teachersList = res.data || [];
      if (teacherCountBadge) teacherCountBadge.textContent = `${teachersList.length} Teachers`;
      renderTeachersTable();
      populateTeacherDropdowns();
      loadDashboardSummary();
    } catch (err) {
      console.error(err);
      teachersTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #dc2626;">Error loading teachers: ${err.message}</td></tr>`;
    }
  }

  async function loadDashboardSummary() {
    try {
      const res = await apiClient.get('/teachers/dashboard-summary');
      if (res && res.success && res.data) {
        const d = res.data;
        if (kpiTotalTeachers) kpiTotalTeachers.textContent = d.totalTeachers || 0;
        if (kpiMonthlyCommitment) kpiMonthlyCommitment.textContent = `৳${(d.totalFixedSalaryCommitment || 0).toLocaleString()}`;
        if (kpiOutstandingAdvances) kpiOutstandingAdvances.textContent = `৳${(d.totalOutstandingAdvances || 0).toLocaleString()}`;
        if (kpiMonthPayment) kpiMonthPayment.textContent = `৳${(d.totalPaidThisMonth || 0).toLocaleString()}`;
      }
    } catch (e) {
      console.error('Error loading dashboard summary', e);
    }
  }

  function renderTeachersTable() {
    const searchVal = (teacherSearchInput?.value || globalSearchInput?.value || '').toLowerCase().trim();
    const streamVal = teacherStreamFilter?.value || '';

    const filtered = teachersList.filter(t => {
      const nameMatch = (t.name || '').toLowerCase().includes(searchVal);
      const phoneMatch = (t.phone || '').includes(searchVal) || (t.phone_secondary || '').includes(searchVal);
      const emailMatch = (t.email || '').toLowerCase().includes(searchVal);
      const subjectMatch = (t.assignments || []).some(a => (a.subject_name || '').toLowerCase().includes(searchVal) || (a.class_name || '').toLowerCase().includes(searchVal));
      const matchSearch = !searchVal || nameMatch || phoneMatch || emailMatch || subjectMatch;

      const matchStream = !streamVal || t.stream === streamVal;
      return matchSearch && matchStream;
    });

    if (filtered.length === 0) {
      teachersTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">No teachers found matching criteria.</td></tr>';
      return;
    }

    teachersTableBody.innerHTML = filtered.map(t => {
      const isHifz = t.stream === 'Hifz';
      const streamBadge = `<span style="display: inline-block; padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.72rem; font-weight: 700; background: ${isHifz ? '#ecfdf5; color: #047857;' : '#e0e7ff; color: #4338ca;'}">${t.stream || 'General'}</span>`;

      // Subjects pills
      let assignmentsHtml = '<span style="color: #94a3b8; font-size: 0.75rem;">None assigned</span>';
      if (t.assignments && t.assignments.length > 0) {
        assignmentsHtml = t.assignments.map(a => `
          <span style="display: inline-block; margin: 2px; padding: 2px 6px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 0.74rem; color: #334155;">
            <strong>${a.class_name}:</strong> ${a.subject_name}
          </span>
        `).join('');
      }

      // Phone display
      const isSecPrimary = t.primary_contact === 'secondary';
      const primPhone = t.phone ? `<div style="font-weight: ${isSecPrimary ? '400' : '600'}; color: #1e293b; display: flex; align-items: center; gap: 4px;">
        <span class="material-symbols-outlined" style="font-size: 0.9rem; color: #0284c7;">call</span> ${t.phone} ${!isSecPrimary ? '<span style="font-size: 0.65rem; background: #e0f2fe; color: #0369a1; padding: 1px 4px; border-radius: 3px;">Primary</span>' : ''}
      </div>` : '';
      const secPhone = t.phone_secondary ? `<div style="font-size: 0.74rem; color: #64748b; margin-top: 2px;">
        ${t.phone_secondary} ${isSecPrimary ? '<span style="font-size: 0.65rem; background: #e0f2fe; color: #0369a1; padding: 1px 4px; border-radius: 3px;">Primary</span>' : ''}
      </div>` : '';

      const advColor = (t.outstanding_advance || 0) > 0 ? '#dc2626' : '#16a34a';

      return `
        <tr>
          <td>
            <div style="font-weight: 700; color: #0f172a; font-size: 0.90rem;">${t.name}</div>
            ${t.email ? `<div style="font-size: 0.75rem; color: #64748b;">${t.email}</div>` : ''}
          </td>
          <td>
            ${primPhone}
            ${secPhone}
          </td>
          <td>
            <div style="margin-bottom: 4px;">${streamBadge}</div>
            <div style="display: flex; flex-wrap: wrap; gap: 2px;">${assignmentsHtml}</div>
          </td>
          <td>
            <span style="font-weight: 700; font-size: 0.92rem; color: #1e293b;">৳${(t.fixed_salary || 0).toLocaleString()}</span>
            <div style="font-size: 0.70rem; color: #64748b;">Monthly fixed</div>
          </td>
          <td>
            <span style="font-weight: 700; font-size: 0.90rem; color: ${advColor};">৳${(t.outstanding_advance || 0).toLocaleString()}</span>
            <div style="font-size: 0.70rem; color: #64748b;">To be adjusted</div>
          </td>
          <td style="text-align: right;">
            <div style="display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap;">
              <button class="btn btn-sm btn-primary pay-salary-btn" data-id="${t.id}" style="padding: 0.3rem 0.5rem; font-size: 0.75rem; background: #16a34a;" title="Pay Monthly Salary">
                Pay Salary
              </button>
              <button class="btn btn-sm btn-secondary advance-btn" data-id="${t.id}" style="padding: 0.3rem 0.5rem; font-size: 0.75rem; color: #dc2626; border-color: #fca5a5;" title="Salary Advance">
                Advance
              </button>
              <button class="btn btn-sm btn-secondary detail-btn" data-id="${t.id}" style="padding: 0.3rem 0.5rem; font-size: 0.75rem;" title="View Ledger">
                Ledger
              </button>
              <button class="btn btn-sm btn-secondary edit-btn" data-id="${t.id}" style="padding: 0.3rem 0.45rem; font-size: 0.75rem;" title="Edit Profile & Assignments">
                <span class="material-symbols-outlined" style="font-size: 0.95rem;">edit</span>
              </button>
              <button class="btn btn-sm btn-secondary delete-btn" data-id="${t.id}" data-name="${t.name}" style="padding: 0.3rem 0.45rem; font-size: 0.75rem; color: #dc2626;" title="Deactivate Teacher">
                <span class="material-symbols-outlined" style="font-size: 0.95rem;">person_off</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach Row Event Listeners
    teachersTableBody.querySelectorAll('.pay-salary-btn').forEach(btn => {
      btn.addEventListener('click', () => openPaySalaryModal(btn.getAttribute('data-id')));
    });

    teachersTableBody.querySelectorAll('.advance-btn').forEach(btn => {
      btn.addEventListener('click', () => openAdvanceModal(btn.getAttribute('data-id')));
    });

    teachersTableBody.querySelectorAll('.detail-btn').forEach(btn => {
      btn.addEventListener('click', () => openDetailModal(btn.getAttribute('data-id')));
    });

    teachersTableBody.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditTeacherModal(btn.getAttribute('data-id')));
    });

    teachersTableBody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => confirmDeactivateTeacher(btn.getAttribute('data-id'), btn.getAttribute('data-name')));
    });
  }

  function populateTeacherDropdowns() {
    const advSelect = document.getElementById('advanceTeacherSelect');
    const salSelect = document.getElementById('salaryTeacherSelect');

    const options = teachersList.map(t => `<option value="${t.id}">${t.name} (৳${(t.fixed_salary || 0).toLocaleString()}/mo - Adv: ৳${(t.outstanding_advance || 0).toLocaleString()})</option>`).join('');

    if (advSelect) advSelect.innerHTML = '<option value="">Select teacher...</option>' + options;
    if (salSelect) salSelect.innerHTML = '<option value="">Select teacher...</option>' + options;
  }

  // ----------------------------------------------------
  // DYNAMIC SUBJECT ASSIGNMENT SELECTOR
  // ----------------------------------------------------
  async function loadSubjectAssignmentOptions(stream, currentTeacherId = null) {
    const container = document.getElementById('subjectAssignmentContainer');
    if (!container) return;

    container.innerHTML = '<p style="font-size: 0.8rem; color: #94a3b8; text-align: center;">Loading subjects...</p>';

    try {
      const url = `/academic/available-subjects?stream=${encodeURIComponent(stream)}${currentTeacherId ? `&teacher_id=${currentTeacherId}` : ''}`;
      const res = await apiClient.get(url);
      if (!res || !res.success) throw new Error(res?.error || 'Failed to fetch available subjects');

      availableSubjects = res.data || [];
      if (availableSubjects.length === 0) {
        container.innerHTML = `<p style="font-size: 0.8rem; color: #64748b; text-align: center;">No subjects configured yet for ${stream} stream.</p>`;
        return;
      }

      // Group subjects by class
      const classMap = new Map();
      availableSubjects.forEach(s => {
        const cKey = `${s.class_id}_${s.class_name}`;
        if (!classMap.has(cKey)) classMap.set(cKey, []);
        classMap.get(cKey).push(s);
      });

      let html = '';
      classMap.forEach((subjs, cKey) => {
        const className = subjs[0]?.class_name || 'Class';
        html += `
          <div style="margin-bottom: 0.75rem;">
            <div style="font-weight: 700; font-size: 0.80rem; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.2rem; margin-bottom: 0.4rem;">
              ${className}
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 0.35rem;">
        `;

        subjs.forEach(sub => {
          const isConflict = sub.is_assigned_to_other;
          const isAssignedToThis = sub.is_assigned_to_current;
          const disabledAttr = isConflict ? 'disabled' : '';
          const checkedAttr = isAssignedToThis ? 'checked' : '';

          let badge = '';
          if (isConflict) {
            badge = `<span style="font-size: 0.65rem; color: #dc2626; background: #fee2e2; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">Assigned to ${sub.assigned_teacher_name}</span>`;
          } else if (isAssignedToThis) {
            badge = `<span style="font-size: 0.65rem; color: #15803d; background: #dcfce7; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">Assigned</span>`;
          }

          html += `
            <label style="display: flex; align-items: flex-start; gap: 0.35rem; font-size: 0.78rem; color: ${isConflict ? '#94a3b8' : '#334155'}; cursor: ${isConflict ? 'not-allowed' : 'pointer'}; padding: 0.2rem; border-radius: 4px;">
              <input type="checkbox" name="subjectAssignment" value="${sub.id}" ${checkedAttr} ${disabledAttr} style="margin-top: 2px;">
              <span><strong>${sub.name}</strong> ${badge}</span>
            </label>
          `;
        });

        html += '</div></div>';
      });

      container.innerHTML = html;
    } catch (err) {
      console.error(err);
      container.innerHTML = `<p style="font-size: 0.8rem; color: #dc2626; text-align: center;">Error loading subjects: ${err.message}</p>`;
    }
  }

  // Stream change in Teacher modal updates subject options
  const teacherStreamSelect = document.getElementById('teacherStreamSelect');
  if (teacherStreamSelect) {
    teacherStreamSelect.addEventListener('change', () => {
      const editId = document.getElementById('teacherEditId')?.value || null;
      loadSubjectAssignmentOptions(teacherStreamSelect.value, editId);
    });
  }

  // ----------------------------------------------------
  // ADD / EDIT TEACHER MODAL ACTIONS
  // ----------------------------------------------------
  const openAddTeacherModalBtn = document.getElementById('openAddTeacherModalBtn');
  if (openAddTeacherModalBtn) {
    openAddTeacherModalBtn.addEventListener('click', () => {
      teacherForm.reset();
      document.getElementById('teacherEditId').value = '';
      document.getElementById('teacherModalTitle').textContent = 'Add New Teacher';
      document.getElementById('teacherFormError').style.display = 'none';
      const streamVal = teacherStreamSelect ? teacherStreamSelect.value : 'General';
      loadSubjectAssignmentOptions(streamVal, null);
      showModal('teacherModal');
    });
  }

  const cancelTeacherModalBtn = document.getElementById('cancelTeacherModalBtn');
  const closeTeacherModalBtn = document.getElementById('closeTeacherModalBtn');
  [cancelTeacherModalBtn, closeTeacherModalBtn].forEach(b => {
    if (b) b.addEventListener('click', () => hideModal('teacherModal'));
  });

  async function openEditTeacherModal(id) {
    try {
      const res = await apiClient.get(`/teachers/${id}`);
      if (!res || !res.success || !res.data) throw new Error(res?.error || 'Teacher not found');

      const t = res.data;
      document.getElementById('teacherEditId').value = t.id;
      document.getElementById('teacherModalTitle').textContent = `Edit Teacher: ${t.name}`;
      document.getElementById('teacherNameInput').value = t.name || '';
      document.getElementById('teacherEmailInput').value = t.email || '';
      document.getElementById('teacherPhoneInput').value = t.phone || '';
      document.getElementById('teacherPhoneSecInput').value = t.phone_secondary || '';
      document.getElementById('fixedSalaryInput').value = t.fixed_salary || '';

      if (teacherStreamSelect) teacherStreamSelect.value = t.stream || 'General';

      // Primary contact radio
      const radios = document.getElementsByName('primaryContactRadio');
      radios.forEach(r => {
        r.checked = (r.value === (t.primary_contact || 'primary'));
      });

      document.getElementById('teacherFormError').style.display = 'none';
      await loadSubjectAssignmentOptions(t.stream || 'General', t.id);
      showModal('teacherModal');
    } catch (e) {
      alert(`Error loading teacher: ${e.message}`);
    }
  }

  // Teacher Form Submit
  if (teacherForm) {
    teacherForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('teacherFormError');
      errBox.style.display = 'none';

      const editId = document.getElementById('teacherEditId').value;
      const name = document.getElementById('teacherNameInput').value.trim();
      const email = document.getElementById('teacherEmailInput').value.trim();
      const phone = document.getElementById('teacherPhoneInput').value.trim();
      const phoneSec = document.getElementById('teacherPhoneSecInput').value.trim();
      const fixedSalary = parseFloat(document.getElementById('fixedSalaryInput').value) || 0;
      const stream = teacherStreamSelect.value;

      let primaryContact = 'primary';
      document.getElementsByName('primaryContactRadio').forEach(r => {
        if (r.checked) primaryContact = r.value;
      });

      // Gather checked subjects
      const checkedBoxes = document.querySelectorAll('input[name="subjectAssignment"]:checked');
      const assignedSubjectIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value, 10));

      if (!name) {
        errBox.textContent = 'Teacher full name is required';
        errBox.style.display = 'block';
        return;
      }
      if (!phone) {
        errBox.textContent = 'Primary contact number is required';
        errBox.style.display = 'block';
        return;
      }

      const payload = {
        name,
        email,
        phone,
        phone_secondary: phoneSec,
        primary_contact: primaryContact,
        fixed_salary: fixedSalary,
        stream,
        assigned_subject_ids: assignedSubjectIds
      };

      const saveBtn = document.getElementById('saveTeacherBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving Teacher...';
      }

      try {
        let res;
        if (editId) {
          res = await apiClient.put(`/teachers/${editId}`, payload);
        } else {
          res = await apiClient.post('/teachers', payload);
        }

        if (!res || !res.success) throw new Error(res?.error || 'Failed to save teacher');

        if (window.showToast) window.showToast(res.message || 'Teacher saved successfully', 'success');
        hideModal('teacherModal');
        await loadTeachers();
      } catch (err) {
        console.error(err);
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Teacher';
        }
      }
    });
  }

  // Deactivate Teacher
  async function confirmDeactivateTeacher(id, name) {
    if (!confirm(`Are you sure you want to deactivate teacher "${name}"? Historical salary, payment, and examination records will remain preserved.`)) {
      return;
    }
    try {
      const res = await apiClient.delete(`/teachers/${id}`);
      if (!res || !res.success) throw new Error(res?.error || 'Failed to deactivate teacher');
      if (window.showToast) window.showToast(res.message || 'Teacher deactivated');
      await loadTeachers();
    } catch (e) {
      alert(`Error deactivating teacher: ${e.message}`);
    }
  }

  // ----------------------------------------------------
  // SALARY ADVANCE MODAL
  // ----------------------------------------------------
  const openTeacherAdvanceModalBtn = document.getElementById('openTeacherAdvanceModalBtn');
  if (openTeacherAdvanceModalBtn) {
    openTeacherAdvanceModalBtn.addEventListener('click', () => openAdvanceModal());
  }

  const cancelTeacherAdvanceBtn = document.getElementById('cancelTeacherAdvanceBtn');
  const closeTeacherAdvanceModalBtn = document.getElementById('closeTeacherAdvanceModalBtn');
  [cancelTeacherAdvanceBtn, closeTeacherAdvanceModalBtn].forEach(b => {
    if (b) b.addEventListener('click', () => hideModal('teacherAdvanceModal'));
  });

  function openAdvanceModal(teacherId = null) {
    teacherAdvanceForm.reset();
    document.getElementById('advanceDateInput').value = todayStr;
    document.getElementById('teacherAdvanceFormError').style.display = 'none';

    if (teacherId) {
      const sel = document.getElementById('advanceTeacherSelect');
      if (sel) sel.value = teacherId;
    }
    showModal('teacherAdvanceModal');
  }

  if (teacherAdvanceForm) {
    teacherAdvanceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('teacherAdvanceFormError');
      errBox.style.display = 'none';

      const teacherId = document.getElementById('advanceTeacherSelect').value;
      const amount = parseFloat(document.getElementById('advanceAmountInput').value);
      const date = document.getElementById('advanceDateInput').value;
      const paymentMethod = document.getElementById('advancePaymentMethod').value;
      const note = document.getElementById('advanceNoteInput').value.trim();

      if (!teacherId) {
        errBox.textContent = 'Please select a teacher';
        errBox.style.display = 'block';
        return;
      }
      if (isNaN(amount) || amount <= 0) {
        errBox.textContent = 'Please enter a valid advance amount';
        errBox.style.display = 'block';
        return;
      }

      try {
        const res = await apiClient.post(`/teachers/${teacherId}/advance`, {
          amount,
          advance_date: date,
          payment_method: paymentMethod,
          note
        });

        if (!res || !res.success) throw new Error(res?.error || 'Failed to record advance');

        if (window.showToast) window.showToast(res.message || 'Advance disbursed successfully');
        hideModal('teacherAdvanceModal');
        await loadTeachers();
      } catch (err) {
        console.error(err);
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      }
    });
  }

  // ----------------------------------------------------
  // PAY MONTHLY FIXED SALARY MODAL
  // ----------------------------------------------------
  const openPaySalaryModalBtn = document.getElementById('openPaySalaryModalBtn');
  if (openPaySalaryModalBtn) {
    openPaySalaryModalBtn.addEventListener('click', () => openPaySalaryModal());
  }

  const cancelPaySalaryBtn = document.getElementById('cancelPaySalaryBtn');
  const closePaySalaryModalBtn = document.getElementById('closePaySalaryModalBtn');
  [cancelPaySalaryBtn, closePaySalaryModalBtn].forEach(b => {
    if (b) b.addEventListener('click', () => hideModal('payFixedSalaryModal'));
  });

  function openPaySalaryModal(teacherId = null) {
    payFixedSalaryForm.reset();
    document.getElementById('salaryMonthInput').value = currentMonthStr;
    document.getElementById('salaryPayDateInput').value = todayStr;
    document.getElementById('paySalaryFormError').style.display = 'none';

    if (teacherId) {
      const sel = document.getElementById('salaryTeacherSelect');
      if (sel) sel.value = teacherId;
    }
    updatePaySalaryPreview();
    showModal('payFixedSalaryModal');
  }

  const salaryTeacherSelect = document.getElementById('salaryTeacherSelect');
  if (salaryTeacherSelect) {
    salaryTeacherSelect.addEventListener('change', updatePaySalaryPreview);
  }

  function updatePaySalaryPreview() {
    const teacherId = parseInt(salaryTeacherSelect?.value, 10);
    const teacher = teachersList.find(t => t.id === teacherId);

    const prevFixed = document.getElementById('previewFixedSalary');
    const prevAdv = document.getElementById('previewOutstandingAdvance');
    const prevDed = document.getElementById('previewAdvanceDeducted');
    const prevNet = document.getElementById('previewNetPayable');

    if (!teacher) {
      if (prevFixed) prevFixed.textContent = '৳0';
      if (prevAdv) prevAdv.textContent = '৳0';
      if (prevDed) prevDed.textContent = '৳0';
      if (prevNet) prevNet.textContent = '৳0';
      return;
    }

    const fixed = teacher.fixed_salary || 0;
    const outstanding = teacher.outstanding_advance || 0;
    const deducted = Math.min(fixed, outstanding);
    const net = fixed - deducted;

    if (prevFixed) prevFixed.textContent = `৳${fixed.toLocaleString()}`;
    if (prevAdv) prevAdv.textContent = `৳${outstanding.toLocaleString()}`;
    if (prevDed) prevDed.textContent = `৳${deducted.toLocaleString()}`;
    if (prevNet) prevNet.textContent = `৳${net.toLocaleString()}`;
  }

  if (payFixedSalaryForm) {
    payFixedSalaryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('paySalaryFormError');
      errBox.style.display = 'none';

      const teacherId = document.getElementById('salaryTeacherSelect').value;
      const month = document.getElementById('salaryMonthInput').value;
      const payDate = document.getElementById('salaryPayDateInput').value;
      const paymentMethod = document.getElementById('salaryPaymentMethod').value;
      const note = document.getElementById('salaryNoteInput').value.trim();

      if (!teacherId) {
        errBox.textContent = 'Please select a teacher';
        errBox.style.display = 'block';
        return;
      }
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        errBox.textContent = 'Please select a valid salary month';
        errBox.style.display = 'block';
        return;
      }

      try {
        const res = await apiClient.post(`/teachers/${teacherId}/pay-fixed`, {
          salary_month: month,
          payment_date: payDate,
          payment_method: paymentMethod,
          note
        });

        if (!res || !res.success) throw new Error(res?.error || 'Failed to process salary payment');

        if (window.showToast) window.showToast(res.message || 'Salary disbursed successfully');
        hideModal('payFixedSalaryModal');
        await loadTeachers();
      } catch (err) {
        console.error(err);
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      }
    });
  }

  // ----------------------------------------------------
  // TEACHER DETAIL / LEDGER MODAL
  // ----------------------------------------------------
  const closeDetailBtn = document.getElementById('closeDetailBtn');
  const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
  [closeDetailBtn, closeDetailModalBtn].forEach(b => {
    if (b) b.addEventListener('click', () => hideModal('teacherDetailModal'));
  });

  async function openDetailModal(teacherId) {
    try {
      const res = await apiClient.get(`/teachers/${teacherId}`);
      if (!res || !res.success || !res.data) throw new Error(res?.error || 'Teacher not found');

      const t = res.data;
      document.getElementById('detailTeacherName').textContent = `${t.name} (${t.stream || 'General'} Faculty)`;
      document.getElementById('detailFixedSalary').textContent = `৳${(t.fixed_salary || 0).toLocaleString()}`;
      document.getElementById('detailOutstandingAdvance').textContent = `৳${(t.outstanding_advance || 0).toLocaleString()}`;
      document.getElementById('detailTotalNetPaid').textContent = `৳${(t.total_salary_paid || 0).toLocaleString()}`;

      // Assignments
      const assignContainer = document.getElementById('detailAssignmentsList');
      if (t.assignments && t.assignments.length > 0) {
        assignContainer.innerHTML = t.assignments.map(a => `
          <span style="background: #e2e8f0; color: #1e293b; padding: 2px 6px; border-radius: 4px; font-weight: 600;">
            ${a.class_name}: ${a.subject_name}
          </span>
        `).join('');
      } else {
        assignContainer.innerHTML = '<span style="color: #64748b;">No active subject assignments</span>';
      }

      // Salary Payments Table
      const salBody = document.getElementById('detailSalaryPaymentsBody');
      if (t.salary_payments && t.salary_payments.length > 0) {
        salBody.innerHTML = t.salary_payments.map(p => `
          <tr>
            <td><strong>${p.salary_month}</strong></td>
            <td>${p.payment_date}</td>
            <td>৳${(p.fixed_salary || 0).toLocaleString()}</td>
            <td style="color: #b45309;">-৳${(p.advance_deducted || 0).toLocaleString()}</td>
            <td style="color: #16a34a; font-weight: 700;">৳${(p.net_paid || 0).toLocaleString()}</td>
            <td>${p.payment_method || 'Cash'}</td>
          </tr>
        `).join('');
      } else {
        salBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 0.75rem; color: #64748b;">No salary payments yet</td></tr>';
      }

      // Advances Table
      const advBody = document.getElementById('detailAdvancesBody');
      if (t.advances && t.advances.length > 0) {
        advBody.innerHTML = t.advances.map(a => `
          <tr>
            <td>${a.advance_date}</td>
            <td style="color: #dc2626; font-weight: 700;">৳${(a.amount || 0).toLocaleString()}</td>
            <td>
              <span style="padding: 1px 5px; border-radius: 3px; font-size: 0.70rem; font-weight: 700; ${a.is_recovered ? 'background: #dcfce7; color: #15803d;' : 'background: #fee2e2; color: #b91c1c;'}">
                ${a.is_recovered ? 'Recovered' : 'Outstanding'}
              </span>
            </td>
            <td>${a.note || 'Salary Advance'}</td>
          </tr>
        `).join('');
      } else {
        advBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 0.75rem; color: #64748b;">No advances taken</td></tr>';
      }

      showModal('teacherDetailModal');
    } catch (e) {
      alert(`Error loading teacher ledger: ${e.message}`);
    }
  }

  // ----------------------------------------------------
  // TAB 2: PAYMENT & ADVANCE HISTORY LOG
  // ----------------------------------------------------
  async function loadPaymentHistory() {
    try {
      paymentHistoryTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">Loading payment log...</td></tr>';
      const monthVal = paymentLogMonthInput?.value || '';

      const [advRes, payRes] = await Promise.all([
        apiClient.get('/teachers/advance-statement'),
        apiClient.get(`/teachers/payment-summary?month=${monthVal}`)
      ]);

      const advances = (advRes && advRes.advances) ? advRes.advances : [];
      const teachersData = (payRes && payRes.data && payRes.data.teachers) ? payRes.data.teachers : [];

      const rows = [];

      // Collect advances
      advances.forEach(a => {
        if (!monthVal || (a.date && a.date.startsWith(monthVal))) {
          rows.push({
            date: a.date,
            teacher_name: a.teacher_name,
            type: '<span style="background: #fee2e2; color: #dc2626; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 0.72rem;">Advance</span>',
            desc: a.note || 'Disbursed Advance',
            gross: '-',
            adj: '-',
            net: `<strong style="color: #dc2626;">৳${(a.amount || 0).toLocaleString()}</strong>`
          });
        }
      });

      // Collect paid salaries
      teachersData.filter(t => t.is_paid).forEach(t => {
        rows.push({
          date: t.payment_date || monthVal,
          teacher_name: t.teacher_name,
          type: '<span style="background: #dcfce7; color: #16a34a; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 0.72rem;">Fixed Salary</span>',
          desc: `Salary for ${monthVal}`,
          gross: `৳${(t.fixed_salary || 0).toLocaleString()}`,
          adj: t.advance_deducted > 0 ? `<span style="color: #b45309;">-৳${t.advance_deducted.toLocaleString()}</span>` : '৳0',
          net: `<strong style="color: #16a34a;">৳${(t.net_paid || 0).toLocaleString()}</strong>`
        });
      });

      rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      if (rows.length === 0) {
        paymentHistoryTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">No salary payments or advances recorded for this period.</td></tr>';
        return;
      }

      paymentHistoryTableBody.innerHTML = rows.map(r => `
        <tr>
          <td>${r.date}</td>
          <td><strong>${r.teacher_name}</strong></td>
          <td>${r.type}</td>
          <td>${r.desc}</td>
          <td>${r.gross}</td>
          <td>${r.adj}</td>
          <td>${r.net}</td>
        </tr>
      `).join('');

    } catch (e) {
      console.error(e);
      paymentHistoryTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #dc2626;">Error loading log: ${e.message}</td></tr>`;
    }
  }

  if (paymentLogMonthInput) {
    paymentLogMonthInput.addEventListener('change', loadPaymentHistory);
  }

  // Search and filter listeners
  if (teacherSearchInput) teacherSearchInput.addEventListener('input', renderTeachersTable);
  if (globalSearchInput) globalSearchInput.addEventListener('input', renderTeachersTable);
  if (teacherStreamFilter) teacherStreamFilter.addEventListener('change', renderTeachersTable);

  // Initial Load
  loadTeachers();
});
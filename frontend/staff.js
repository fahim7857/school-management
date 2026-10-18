// Centralized Staff Management & Accounting Frontend Controller
// Follows identical patterns and utilities as teachers.js and students.js

let staffList = [];
let selectedStaffForDetail = null;

const apiClient = window.api || (typeof api !== 'undefined' ? api : {
  get: (url, p) => window.authFetch ? window.authFetch('/admission_3/api' + url).then(r => r.json()) : fetch('/admission_3/api' + url).then(r => r.json()),
  post: (url, b) => window.authFetch ? window.authFetch('/admission_3/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()) : fetch('/admission_3/api' + url, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()),
  put: (url, b) => window.authFetch ? window.authFetch('/admission_3/api' + url, { method: 'PUT', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()) : fetch('/admission_3/api' + url, { method: 'PUT', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()),
  delete: (url) => window.authFetch ? window.authFetch('/admission_3/api' + url, { method: 'DELETE' }).then(r => r.json()) : fetch('/admission_3/api' + url, { method: 'DELETE' }).then(r => r.json())
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

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getTodayDhakaDate() {
  if (typeof window.getLocalIsoDate === 'function') {
    return window.getLocalIsoDate();
  }
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const dhakaTime = new Date(utc + (3600000 * 6));
  const year = dhakaTime.getFullYear();
  const month = String(dhakaTime.getMonth() + 1).padStart(2, '0');
  const day = String(dhakaTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = '';
    modal.classList.add('open');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  if (typeof window.openModal === 'function') {
    window.openModal(id);
  }
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open');
    modal.classList.remove('active');
    modal.style.display = '';
    document.body.style.overflow = '';
  }
  if (typeof window.closeModal === 'function') {
    window.closeModal(id);
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
    display: flex;
    align-items: center;
    gap: 8px;
    transition: opacity 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function showFormError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

function clearFormError(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// ----------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const topDate = document.getElementById('topbarDate');
  if (topDate) {
    const today = getTodayDhakaDate();
    topDate.textContent = formatDate(today);
  }

  // Populate default dates
  const todayVal = getTodayDhakaDate();
  const staffPayDate = document.getElementById('staffPayDateInput');
  if (staffPayDate) staffPayDate.value = todayVal;

  const staffStatementDate = document.getElementById('staffStatementDateInput');
  if (staffStatementDate) staffStatementDate.value = todayVal;

  // Setup Month Filter dropdown
  populateMonthFilter();

  // Setup modal triggers and handlers
  setupEventListeners();

  // Wait for auth if ready
  if (window.authReady) {
    try {
      await window.authReady;
    } catch (e) {
      console.warn('Auth ready warning:', e);
    }
  }

  // Load initial data
  await loadStaffData();
});

function populateMonthFilter() {
  const sel = document.getElementById('staffFilterMonth');
  if (!sel) return;

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const currentMonthVal = curYear + '-' + (curMonth < 10 ? '0' : '') + curMonth;

  let options = '<option value="">All Time</option>';
  for (let i = 0; i < 18; i++) {
    const d = new Date(curYear, curMonth - 1 - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const val = y + '-' + (m < 10 ? '0' : '') + m;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    options += `<option value="${val}" ${val === currentMonthVal ? 'selected' : ''}>${label}</option>`;
  }
  sel.innerHTML = options;
}

function setupEventListeners() {
  // Global & Local Search
  const searchInput = document.getElementById('staffFilterSearch');
  if (searchInput) searchInput.addEventListener('input', renderStaffTable);

  const globalSearch = document.getElementById('globalSearchInput');
  if (globalSearch) {
    globalSearch.addEventListener('input', (e) => {
      if (searchInput) searchInput.value = e.target.value;
      renderStaffTable();
    });
  }

  const postFilter = document.getElementById('staffFilterPost');
  if (postFilter) postFilter.addEventListener('change', renderStaffTable);

  const monthFilter = document.getElementById('staffFilterMonth');
  if (monthFilter) {
    monthFilter.addEventListener('change', () => {
      loadStaffData();
    });
  }

  // Add Staff Modal
  const openAddBtn = document.getElementById('openAddStaffModalBtn');
  if (openAddBtn) {
    openAddBtn.addEventListener('click', () => {
      clearFormError('staffFormError');
      const form = document.getElementById('staffForm');
      if (form) form.reset();
      showModal('staffModal');
    });
  }

  const closeAddBtn = document.getElementById('closeStaffModalBtn');
  if (closeAddBtn) closeAddBtn.addEventListener('click', () => hideModal('staffModal'));

  const cancelAddBtn = document.getElementById('cancelStaffBtn');
  if (cancelAddBtn) cancelAddBtn.addEventListener('click', () => hideModal('staffModal'));

  const staffForm = document.getElementById('staffForm');
  if (staffForm) staffForm.addEventListener('submit', handleAddStaff);

  // Edit Staff Modal
  const closeEditBtn = document.getElementById('closeStaffEditModalBtn');
  if (closeEditBtn) closeEditBtn.addEventListener('click', () => hideModal('staffEditModal'));

  const cancelEditBtn = document.getElementById('cancelStaffEditBtn');
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => hideModal('staffEditModal'));

  const staffEditForm = document.getElementById('staffEditForm');
  if (staffEditForm) staffEditForm.addEventListener('submit', handleEditStaff);

  // Pay Staff Modal
  const openPayBtn = document.getElementById('openStaffPayModalBtn');
  if (openPayBtn) {
    openPayBtn.addEventListener('click', () => {
      clearFormError('staffPayFormError');
      const form = document.getElementById('staffPayForm');
      if (form) form.reset();
      const pDate = document.getElementById('staffPayDateInput');
      if (pDate) pDate.value = getTodayDhakaDate();
      populateStaffSelect();
      const infoBox = document.getElementById('selectedStaffInfoBox');
      if (infoBox) infoBox.style.display = 'none';
      showModal('staffPayModal');
    });
  }

  const closePayBtn = document.getElementById('closeStaffPayModalBtn');
  if (closePayBtn) closePayBtn.addEventListener('click', () => hideModal('staffPayModal'));

  const cancelPayBtn = document.getElementById('cancelStaffPayBtn');
  if (cancelPayBtn) cancelPayBtn.addEventListener('click', () => hideModal('staffPayModal'));

  const staffPayForm = document.getElementById('staffPayForm');
  if (staffPayForm) staffPayForm.addEventListener('submit', handleRecordStaffPayment);

  const payStaffSelect = document.getElementById('payStaffSelect');
  if (payStaffSelect) payStaffSelect.addEventListener('change', handleStaffSelectChange);

  // Daily Statement Modal
  const openStatementBtn = document.getElementById('openStaffStatementBtn');
  if (openStatementBtn) {
    openStatementBtn.addEventListener('click', () => {
      showModal('staffAdvanceStatementModal');
      fetchAndRenderStaffAdvanceStatement();
    });
  }

  const closeStatementModalBtn = document.getElementById('closeStaffStatementModalBtn');
  if (closeStatementModalBtn) closeStatementModalBtn.addEventListener('click', () => hideModal('staffAdvanceStatementModal'));

  const closeStaffStatementBtn = document.getElementById('closeStaffStatementBtn');
  if (closeStaffStatementBtn) closeStaffStatementBtn.addEventListener('click', () => hideModal('staffAdvanceStatementModal'));

  const stDateInput = document.getElementById('staffStatementDateInput');
  if (stDateInput) {
    stDateInput.addEventListener('change', fetchAndRenderStaffAdvanceStatement);
  }

  // Detail / Ledger Modal
  const closeDetailModalBtn = document.getElementById('closeStaffDetailModalBtn');
  if (closeDetailModalBtn) closeDetailModalBtn.addEventListener('click', () => hideModal('staffDetailModal'));

  const closeDetailBtn = document.getElementById('closeDetailBtn');
  if (closeDetailBtn) closeDetailBtn.addEventListener('click', () => hideModal('staffDetailModal'));

  const detailQuickPayBtn = document.getElementById('detailQuickPayBtn');
  if (detailQuickPayBtn) {
    detailQuickPayBtn.addEventListener('click', () => {
      if (!selectedStaffForDetail) return;
      hideModal('staffDetailModal');
      openPayModalForStaff(selectedStaffForDetail.id);
    });
  }

  // Backdrop click to close modals
  ['staffModal', 'staffEditModal', 'staffPayModal', 'staffDetailModal', 'staffAdvanceStatementModal'].forEach(id => {
    const m = document.getElementById(id);
    if (m) {
      m.addEventListener('click', (e) => {
        if (e.target === m) hideModal(id);
      });
    }
  });

  // Escape key to dismiss modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['staffModal', 'staffEditModal', 'staffPayModal', 'staffDetailModal', 'staffAdvanceStatementModal'].forEach(id => {
        hideModal(id);
      });
    }
  });

  // Logout button handling if present in HTML
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (confirm('Are you sure you want to log out?')) {
        if (window.auth && typeof window.auth.signOut === 'function') {
          await window.auth.signOut();
        } else {
          window.location.replace('login.html');
        }
      }
    });
  }
}

// ----------------------------------------------------
// DATA LOADING & RENDERING
// ----------------------------------------------------
async function loadStaffData() {
  try {
    const monthSel = document.getElementById('staffFilterMonth');
    const selectedMonth = monthSel ? monthSel.value : '';

    let url = '/staff';
    if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
      url += '?month=' + encodeURIComponent(selectedMonth);
    }

    const res = await apiClient.get(url);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load staff records');

    staffList = res.staff || [];
    renderKPIs(res);
    populatePostFilter();
    renderStaffTable();
  } catch (err) {
    console.error('Error loading staff:', err);
    notify(err.message || 'Error loading staff records', 'error');
    const tbody = document.getElementById('staffTableBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #dc2626; padding: 2rem;">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

async function renderKPIs(apiRes) {
  const totalStaffEl = document.getElementById('statTotalStaff');
  const fixedSalaryEl = document.getElementById('statTotalFixedSalary');
  const todayPaidEl = document.getElementById('statTodayPaid');
  const totalPaidEl = document.getElementById('statTotalPaid');
  const paidTitleEl = document.getElementById('statPaidTitle');
  const paidSubEl = document.getElementById('statPaidSub');
  const paidColHeader = document.getElementById('staffPaidColHeader');

  if (totalStaffEl) totalStaffEl.textContent = staffList.length;

  let totalFixed = 0;
  staffList.forEach(s => {
    totalFixed += (parseFloat(s.fixed_salary) || 0);
  });
  if (fixedSalaryEl) fixedSalaryEl.textContent = `৳${totalFixed.toLocaleString()}`;

  // Month-wise vs All-time paid
  const monthSel = document.getElementById('staffFilterMonth');
  const selectedMonth = monthSel ? monthSel.value : '';

  if (selectedMonth && monthSel.selectedIndex >= 0) {
    const monthText = monthSel.options[monthSel.selectedIndex].text;
    if (paidTitleEl) paidTitleEl.textContent = `${monthText.toUpperCase()} STAFF PAYMENT`;
    if (paidSubEl) paidSubEl.textContent = `Paid in ${monthText}`;
    if (paidColHeader) paidColHeader.textContent = `Month Payment / Advance`;

    let monthTotal = (apiRes && typeof apiRes.total_month_paid === 'number')
      ? apiRes.total_month_paid
      : staffList.reduce((sum, s) => sum + (parseFloat(s.total_paid) || 0), 0);

    if (totalPaidEl) totalPaidEl.textContent = `৳${monthTotal.toLocaleString()}`;
  } else {
    if (paidTitleEl) paidTitleEl.textContent = 'ALL-TIME STAFF PAID';
    if (paidSubEl) paidSubEl.textContent = 'Cumulative staff expenses';
    if (paidColHeader) paidColHeader.textContent = 'Total Paid / Advance';

    let allTimeTotal = (apiRes && typeof apiRes.total_all_time_paid === 'number')
      ? apiRes.total_all_time_paid
      : staffList.reduce((sum, s) => sum + (parseFloat(s.all_time_paid || s.total_paid) || 0), 0);

    if (totalPaidEl) totalPaidEl.textContent = `৳${allTimeTotal.toLocaleString()}`;
  }

  // Fetch today's total from daily statement endpoint
  try {
    const today = getTodayDhakaDate();
    const stRes = await apiClient.get(`/staff/advance-statement?date=${encodeURIComponent(today)}`);
    if (stRes && stRes.success && todayPaidEl) {
      todayPaidEl.textContent = `৳${(stRes.totalAmount || 0).toLocaleString()}`;
    }
  } catch (e) {
    // Non-critical if offline or statement empty
  }
}

function populatePostFilter() {
  const sel = document.getElementById('staffFilterPost');
  if (!sel) return;
  const currentVal = sel.value;

  const posts = Array.from(new Set(staffList.map(s => (s.work_post || '').trim()).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">All Work Posts</option>' +
    posts.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

  if (currentVal && posts.includes(currentVal)) {
    sel.value = currentVal;
  }
}

function populateStaffSelect() {
  const sel = document.getElementById('payStaffSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select staff member...</option>' +
    staffList.map(s => `<option value="${s.id}">${escapeHtml(s.name)} — ${escapeHtml(s.work_post || 'Staff')} (Fixed: ৳${(s.fixed_salary || 0).toLocaleString()})</option>`).join('');
}

function handleStaffSelectChange() {
  const sel = document.getElementById('payStaffSelect');
  const infoBox = document.getElementById('selectedStaffInfoBox');
  if (!sel || !infoBox) return;

  const staffId = parseInt(sel.value, 10);
  const staff = staffList.find(s => s.id === staffId);
  if (!staff) {
    infoBox.style.display = 'none';
    return;
  }

  document.getElementById('boxStaffName').textContent = staff.name;
  document.getElementById('boxStaffPost').textContent = staff.work_post || 'Office Staff';
  document.getElementById('boxStaffFixed').textContent = `৳${(staff.fixed_salary || 0).toLocaleString()}`;
  document.getElementById('boxStaffPaid').textContent = `৳${(staff.total_paid || 0).toLocaleString()}`;
  infoBox.style.display = 'block';
}

function renderStaffTable() {
  const tbody = document.getElementById('staffTableBody');
  if (!tbody) return;

  const query = (document.getElementById('staffFilterSearch')?.value || '').trim().toLowerCase();
  const selectedPost = (document.getElementById('staffFilterPost')?.value || '').trim().toLowerCase();

  const filtered = staffList.filter(s => {
    const matchQuery = !query ||
      (s.name && s.name.toLowerCase().includes(query)) ||
      (s.phone && s.phone.toLowerCase().includes(query)) ||
      (s.work_post && s.work_post.toLowerCase().includes(query)) ||
      (s.address && s.address.toLowerCase().includes(query));

    const matchPost = !selectedPost || ((s.work_post || '').trim().toLowerCase() === selectedPost);
    return matchQuery && matchPost;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">
          ${staffList.length === 0 ? 'No staff members registered yet. Click "+ Add New Staff" above.' : 'No matching staff members found.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const fixed = parseFloat(s.fixed_salary) || 0;
    const paid = parseFloat(s.total_paid) || 0;

    return `
      <tr>
        <td>
          <div style="font-weight: 700; color: #0284c7; cursor: pointer; display: flex; align-items: center; gap: 0.4rem;"
               class="view-staff-ledger" data-id="${s.id}" title="Click to view full payment history ledger">
            <span class="material-symbols-outlined" style="font-size: 1.15rem; color: #0284c7;">person</span>
            ${escapeHtml(s.name)}
          </div>
        </td>
        <td>
          <span class="rate-badge" style="background: #e0f2fe; color: #0369a1; font-weight: 600; padding: 0.25rem 0.6rem; border-radius: 6px;">
            ${escapeHtml(s.work_post || 'Staff')}
          </span>
        </td>
        <td style="color: #475569;">
          ${s.phone ? escapeHtml(s.phone) : '<span style="color: #94a3b8;">N/A</span>'}
        </td>
        <td style="color: #475569;">
          ${s.address ? escapeHtml(s.address) : '<span style="color: #94a3b8;">N/A</span>'}
        </td>
        <td style="text-align: right; font-weight: 600; color: #1e293b;">
          ৳${fixed.toLocaleString()}
        </td>
        <td style="text-align: right; font-weight: 700; color: #16a34a;">
          ৳${paid.toLocaleString()}
        </td>
        <td style="text-align: right;">
          <div style="display: flex; gap: 0.35rem; justify-content: flex-end;">
            <button class="btn btn-sm btn-primary pay-staff-btn" data-id="${s.id}" title="Record payment / advance"
              style="background: #0284c7; border-color: #0284c7; font-weight: 600; padding: 0.25rem 0.65rem;">
              <span class="material-symbols-outlined" style="font-size: 0.95rem;">payments</span>
              Pay / Advance
            </button>
            <button class="btn btn-sm btn-secondary edit-staff-btn" data-id="${s.id}" title="Edit profile"
              style="padding: 0.25rem 0.5rem;">
              <span class="material-symbols-outlined" style="font-size: 0.95rem;">edit</span>
            </button>
            <button class="btn btn-sm btn-secondary delete-staff-btn" data-id="${s.id}" title="Delete staff"
              style="padding: 0.25rem 0.5rem; color: #dc2626;">
              <span class="material-symbols-outlined" style="font-size: 0.95rem;">delete</span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  attachTableEventListeners();
}

function attachTableEventListeners() {
  document.querySelectorAll('.view-staff-ledger').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
      openStaffDetailModal(id);
    });
  });

  document.querySelectorAll('.pay-staff-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
      openPayModalForStaff(id);
    });
  });

  document.querySelectorAll('.edit-staff-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
      openEditModal(id);
    });
  });

  document.querySelectorAll('.delete-staff-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
      handleDeleteStaff(id);
    });
  });
}

// ----------------------------------------------------
// ADD, EDIT, DELETE HANDLERS
// ----------------------------------------------------
async function handleAddStaff(e) {
  e.preventDefault();
  clearFormError('staffFormError');

  const name = document.getElementById('staffNameInput').value.trim();
  const phone = document.getElementById('staffPhoneInput').value.trim();
  const phone_secondary = (document.getElementById('staffPhoneSecondaryInput')?.value || '').trim();
  const primary_contact = document.getElementById('staffPrimaryContactSelect')?.value || 'primary';
  const address = document.getElementById('staffAddressInput').value.trim();
  const work_post = document.getElementById('staffWorkPostInput').value.trim();
  const emergency_contact = (document.getElementById('staffEmergencyContactInput')?.value || '').trim();
  const optional_details = (document.getElementById('staffOptionalDetailsInput')?.value || '').trim();
  const fixed_salary = parseFloat(document.getElementById('staffFixedSalaryInput').value) || 0;

  if (!name) {
    showFormError('staffFormError', 'Staff name is required.');
    return;
  }
  if (!work_post) {
    showFormError('staffFormError', 'Work post / position is required.');
    return;
  }

  try {
    const res = await apiClient.post('/staff', {
      name,
      phone,
      phone_secondary,
      primary_contact,
      address,
      work_post,
      fixed_salary,
      emergency_contact,
      optional_details
    });

    if (res && res.success) {
      notify(res.message || 'Staff member added successfully!', 'success');
      hideModal('staffModal');
      document.getElementById('staffForm').reset();
      await loadStaffData();
    } else {
      showFormError('staffFormError', res?.error || 'Failed to add staff member.');
    }
  } catch (err) {
    console.error('Error adding staff:', err);
    showFormError('staffFormError', err.message || 'Failed to add staff member.');
  }
}

function openEditModal(staffId) {
  const staff = staffList.find(s => s.id === staffId);
  if (!staff) return;

  clearFormError('staffEditFormError');
  document.getElementById('editStaffId').value = staff.id;
  document.getElementById('editStaffNameInput').value = staff.name || '';
  document.getElementById('editStaffPhoneInput').value = staff.phone || '';
  if (document.getElementById('editStaffPhoneSecondaryInput')) {
    document.getElementById('editStaffPhoneSecondaryInput').value = staff.phone_secondary || '';
  }
  if (document.getElementById('editStaffPrimaryContactSelect')) {
    document.getElementById('editStaffPrimaryContactSelect').value = staff.primary_contact || 'primary';
  }
  document.getElementById('editStaffAddressInput').value = staff.address || '';
  document.getElementById('editStaffWorkPostInput').value = staff.work_post || '';
  if (document.getElementById('editStaffEmergencyContactInput')) {
    document.getElementById('editStaffEmergencyContactInput').value = staff.emergency_contact || '';
  }
  if (document.getElementById('editStaffOptionalDetailsInput')) {
    document.getElementById('editStaffOptionalDetailsInput').value = staff.optional_details || '';
  }
  document.getElementById('editStaffFixedSalaryInput').value = staff.fixed_salary !== undefined ? staff.fixed_salary : 0;

  showModal('staffEditModal');
}

async function handleEditStaff(e) {
  e.preventDefault();
  clearFormError('staffEditFormError');

  const id = parseInt(document.getElementById('editStaffId').value, 10);
  const name = document.getElementById('editStaffNameInput').value.trim();
  const phone = document.getElementById('editStaffPhoneInput').value.trim();
  const phone_secondary = (document.getElementById('editStaffPhoneSecondaryInput')?.value || '').trim();
  const primary_contact = document.getElementById('editStaffPrimaryContactSelect')?.value || 'primary';
  const address = document.getElementById('editStaffAddressInput').value.trim();
  const work_post = document.getElementById('editStaffWorkPostInput').value.trim();
  const emergency_contact = (document.getElementById('editStaffEmergencyContactInput')?.value || '').trim();
  const optional_details = (document.getElementById('editStaffOptionalDetailsInput')?.value || '').trim();
  const fixed_salary = parseFloat(document.getElementById('editStaffFixedSalaryInput').value) || 0;

  if (!name) {
    showFormError('staffEditFormError', 'Staff name is required.');
    return;
  }

  try {
    const res = await apiClient.put(`/staff/${id}`, {
      name,
      phone,
      phone_secondary,
      primary_contact,
      address,
      work_post,
      fixed_salary,
      emergency_contact,
      optional_details
    });

    if (res && res.success) {
      notify(res.message || 'Staff profile updated successfully!', 'success');
      hideModal('staffEditModal');
      await loadStaffData();
    } else {
      showFormError('staffEditFormError', res?.error || 'Failed to update staff profile.');
    }
  } catch (err) {
    console.error('Error editing staff:', err);
    showFormError('staffEditFormError', err.message || 'Failed to update staff profile.');
  }
}

async function handleDeleteStaff(staffId) {
  const staff = staffList.find(s => s.id === staffId);
  if (!staff) return;

  const confirmMsg = `Are you sure you want to delete staff member "${staff.name}"?\n\nThis will remove their profile and all associated staff payment records.`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await apiClient.delete(`/staff/${staffId}`);
    if (res && res.success) {
      notify(res.message || 'Staff deleted successfully!', 'success');
      await loadStaffData();
    } else {
      notify(res?.error || 'Failed to delete staff member', 'error');
    }
  } catch (err) {
    console.error('Delete error:', err);
    notify(err.message || 'Failed to delete staff member', 'error');
  }
}

// ----------------------------------------------------
// PAYMENT & ADVANCE RECORDING
// ----------------------------------------------------
function openPayModalForStaff(staffId) {
  clearFormError('staffPayFormError');
  const form = document.getElementById('staffPayForm');
  if (form) form.reset();

  const pDate = document.getElementById('staffPayDateInput');
  if (pDate) pDate.value = getTodayDhakaDate();

  populateStaffSelect();
  const sel = document.getElementById('payStaffSelect');
  if (sel) {
    sel.value = staffId;
    handleStaffSelectChange();
  }
  showModal('staffPayModal');
}

async function handleRecordStaffPayment(e) {
  e.preventDefault();
  clearFormError('staffPayFormError');

  const staffId = parseInt(document.getElementById('payStaffSelect').value, 10);
  const amount = parseFloat(document.getElementById('staffPayAmountInput').value);
  const paymentDate = document.getElementById('staffPayDateInput').value;
  const note = document.getElementById('staffPayNoteInput').value.trim();

  if (!staffId) {
    showFormError('staffPayFormError', 'Please select a staff member.');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    showFormError('staffPayFormError', 'Please enter a valid positive payment amount.');
    return;
  }

  try {
    const res = await apiClient.post(`/staff/${staffId}/pay`, {
      amount,
      payment_date: paymentDate || getTodayDhakaDate(),
      note: note || 'Staff Salary / Advance Payment'
    });

    if (res && res.success) {
      notify(res.message || 'Payment recorded and included in Expense system successfully!', 'success');
      hideModal('staffPayModal');
      document.getElementById('staffPayForm').reset();
      await loadStaffData();
    } else {
      showFormError('staffPayFormError', res?.error || 'Failed to record staff payment.');
    }
  } catch (err) {
    console.error('Staff payment error:', err);
    showFormError('staffPayFormError', err.message || 'Failed to record staff payment.');
  }
}

// ----------------------------------------------------
// DETAIL / LEDGER MODAL
// ----------------------------------------------------
async function openStaffDetailModal(staffId) {
  try {
    const res = await apiClient.get(`/staff/${staffId}`);
    if (!res || !res.success) {
      notify(res?.error || 'Staff member not found', 'error');
      return;
    }

    selectedStaffForDetail = res.data;
    const s = selectedStaffForDetail;

    document.getElementById('detailStaffName').textContent = `${s.name} • Ledger & Details`;
    document.getElementById('detailWorkPost').textContent = s.work_post || 'Staff';
    document.getElementById('detailFixedSalary').textContent = `৳${(s.fixed_salary || 0).toLocaleString()}`;
    document.getElementById('detailTotalPaid').textContent = `৳${(s.total_paid || 0).toLocaleString()}`;
    const primaryBadge = s.primary_contact === 'secondary' ? '' : ' <span style="font-size: 0.68rem; background: #dbeafe; color: #1e40af; padding: 1px 5px; border-radius: 4px;">Primary</span>';
    const secondaryBadge = s.primary_contact === 'secondary' ? ' <span style="font-size: 0.68rem; background: #dbeafe; color: #1e40af; padding: 1px 5px; border-radius: 4px;">Primary</span>' : '';

    document.getElementById('detailStaffPhone').innerHTML = (s.phone ? escapeHtml(s.phone) : 'N/A') + (s.phone ? primaryBadge : '');
    const secEl = document.getElementById('detailStaffPhoneSecondary');
    if (secEl) secEl.innerHTML = (s.phone_secondary ? escapeHtml(s.phone_secondary) : 'N/A') + (s.phone_secondary ? secondaryBadge : '');
    const emEl = document.getElementById('detailStaffEmergency');
    if (emEl) emEl.textContent = s.emergency_contact || 'N/A';
    document.getElementById('detailStaffAddress').textContent = s.address || 'N/A';
    const optEl = document.getElementById('detailStaffOptional');
    if (optEl) optEl.textContent = s.optional_details || 'None';

    const tbody = document.getElementById('detailPaymentHistoryBody');
    const payments = s.payments || [];

    if (payments.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 1.25rem; color: #64748b;">No payment records logged yet.</td></tr>`;
    } else {
      tbody.innerHTML = payments.map(p => `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 8px; color: #475569; font-weight: 600;">${formatDate(p.payment_date)}</td>
          <td style="padding: 8px; font-weight: 700; color: #16a34a;">৳${(p.amount || 0).toLocaleString()}</td>
          <td style="padding: 8px; color: #475569; font-size: 0.78rem;">${escapeHtml(p.note || 'Salary / Advance Payment')}</td>
        </tr>
      `).join('');
    }

    showModal('staffDetailModal');
  } catch (err) {
    console.error('Error loading staff details:', err);
    notify(err.message || 'Error loading staff details', 'error');
  }
}

// ----------------------------------------------------
// DAILY ADVANCE & PAYMENT STATEMENT
// ----------------------------------------------------
async function fetchAndRenderStaffAdvanceStatement() {
  const container = document.getElementById('staffStatementTableBody');
  const totalEl = document.getElementById('staffStatementTotalAmount');
  const dateDisplay = document.getElementById('staffStatementDateDisplay');
  const dateInput = document.getElementById('staffStatementDateInput');

  if (!container) return;
  const dateVal = dateInput && dateInput.value ? dateInput.value : getTodayDhakaDate();
  if (dateDisplay) dateDisplay.textContent = `Date: ${formatDate(dateVal)}`;

  container.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 1.5rem; color: #64748b;">Loading statement data...</td></tr>`;

  try {
    const res = await apiClient.get(`/staff/advance-statement?date=${encodeURIComponent(dateVal)}`);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to load staff statement');

    const payments = res.payments || [];
    const totalAmount = res.totalAmount || 0;

    if (totalEl) totalEl.textContent = `৳${totalAmount.toLocaleString()}`;

    if (payments.length === 0) {
      container.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 1.5rem; color: #64748b;">No staff payment or advance records found for ${formatDate(dateVal)}.</td></tr>`;
      return;
    }

    container.innerHTML = payments.map(p => `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 8px; color: #475569; white-space: nowrap;">${formatDate(p.date || p.payment_date || dateVal)}</td>
        <td style="padding: 8px; font-weight: 700; color: #0f172a;">${escapeHtml(p.staff_name)}</td>
        <td style="padding: 8px; color: #0369a1; font-weight: 600;">${escapeHtml(p.work_post || 'Office Staff')}</td>
        <td style="padding: 8px; color: #475569; font-size: 0.78rem;">${escapeHtml(p.description || p.note || 'Staff Salary / Advance')}</td>
        <td style="padding: 8px; text-align: right; font-weight: 700; color: #16a34a;">৳${(p.amount || 0).toLocaleString()}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Error loading staff statement:', err);
    container.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 1.5rem; color: #dc2626;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

window.fetchAndRenderStaffAdvanceStatement = fetchAndRenderStaffAdvanceStatement;
window.showModal = showModal;
window.hideModal = hideModal;
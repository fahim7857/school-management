document.addEventListener('DOMContentLoaded', () => {
  const staffForm = document.getElementById('application-form');
  const teacherForm = document.getElementById('teacher-form');
  const message = document.getElementById('application-message');

  const tabStaffBtn = document.getElementById('tab-staff-btn');
  const tabTeacherBtn = document.getElementById('tab-teacher-btn');
  const staffSection = document.getElementById('staff-section');
  const teacherSection = document.getElementById('teacher-section');

  const classesLoading = document.getElementById('classes-loading');
  const classesContainer = document.getElementById('classes-container');

  let academicClasses = [];

  function showMessage(text, type = 'error') {
    message.textContent = text;
    message.className = `auth-message visible ${type}`;
  }

  function clearMessage() {
    message.textContent = '';
    message.className = 'auth-message';
  }

  function switchTab(tab) {
    clearMessage();
    if (tab === 'teacher') {
      tabTeacherBtn.classList.add('active');
      tabTeacherBtn.style.background = '#e0e7ff';
      tabTeacherBtn.style.color = '#4338ca';

      tabStaffBtn.classList.remove('active');
      tabStaffBtn.style.background = 'transparent';
      tabStaffBtn.style.color = '#64748b';

      staffSection.style.display = 'none';
      teacherSection.style.display = 'block';

      if (academicClasses.length === 0) {
        loadTeacherOptions();
      }
    } else {
      tabStaffBtn.classList.add('active');
      tabStaffBtn.style.background = '#e0e7ff';
      tabStaffBtn.style.color = '#4338ca';

      tabTeacherBtn.classList.remove('active');
      tabTeacherBtn.style.background = 'transparent';
      tabTeacherBtn.style.color = '#64748b';

      teacherSection.style.display = 'none';
      staffSection.style.display = 'block';
    }
  }

  tabStaffBtn.addEventListener('click', () => switchTab('staff'));
  tabTeacherBtn.addEventListener('click', () => switchTab('teacher'));

  // Read URL query parameter
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'teacher') {
    switchTab('teacher');
  }

  // Load classes & subjects for teacher application
  async function loadTeacherOptions() {
    classesLoading.style.display = 'block';
    classesContainer.style.display = 'none';

    try {
      const res = await fetch('/abms/api/public/teacher-application-options');
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || json.message || 'Failed to load classes.');
      }

      academicClasses = json.data?.classes || [];
      renderTeacherClasses(academicClasses);
      classesLoading.style.display = 'none';
      classesContainer.style.display = 'block';
    } catch (err) {
      console.error('Error loading options:', err);
      classesLoading.textContent = 'Unable to load academic classes. Please refresh or try again later.';
      classesLoading.style.color = '#ef4444';
    }
  }

  function renderTeacherClasses(classes) {
    if (!classes || classes.length === 0) {
      classesContainer.innerHTML = '<p style="color: #64748b; font-size: 0.85rem;">No active classes found.</p>';
      return;
    }

    classesContainer.innerHTML = classes.map(c => {
      const subjectsHtml = (c.subjects && c.subjects.length > 0)
        ? c.subjects.map(s => `
            <label class="subject-pill">
              <input type="checkbox" name="subject_${c.id}" value="${s.id}">
              <span>${s.name} ${s.code ? `(${s.code})` : ''}</span>
            </label>
          `).join('')
        : '<p style="font-size: 0.78rem; color: #94a3b8; margin: 0.25rem 0;">No subjects added to this class yet.</p>';

      return `
        <div class="class-card" id="class-card-${c.id}">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-weight: 700; color: #1e293b; font-size: 0.88rem;">
              <input type="checkbox" class="class-select-checkbox" data-class-id="${c.id}" style="width: 1rem; height: 1rem; cursor: pointer;">
              <span>${c.name} <span style="font-size: 0.75rem; font-weight: normal; color: #64748b;">(${c.stream})</span></span>
            </label>
            <span style="font-size: 0.72rem; padding: 0.15rem 0.45rem; background: #e2e8f0; border-radius: 4px; color: #475569;">
              ${c.subjects ? c.subjects.length : 0} Subjects
            </span>
          </div>

          <div class="class-details" id="class-details-${c.id}" style="display: none; margin-top: 0.75rem; padding-top: 0.65rem; border-top: 1px dashed #cbd5e1;">
            <div style="margin-bottom: 0.6rem;">
              <label style="display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.82rem; color: #4338ca; font-weight: 600;">
                <input type="checkbox" class="class-teacher-checkbox" data-class-id="${c.id}" style="cursor: pointer;">
                <span>⭐ Apply as Class Teacher for ${c.name}</span>
              </label>
            </div>

            <div style="font-size: 0.78rem; font-weight: 600; color: #475569; margin-bottom: 0.35rem;">
              Select Subjects to Teach:
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
              ${subjectsHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach listeners for expanding/collapsing classes
    classesContainer.querySelectorAll('.class-select-checkbox').forEach(cb => {
      cb.addEventListener('change', e => {
        const classId = e.target.dataset.classId;
        const details = document.getElementById(`class-details-${classId}`);
        const card = document.getElementById(`class-card-${classId}`);
        if (e.target.checked) {
          details.style.display = 'block';
          card.classList.add('selected');
        } else {
          details.style.display = 'none';
          card.classList.remove('selected');
          // uncheck all subjects and class teacher checkbox inside
          details.querySelectorAll('input[type="checkbox"]').forEach(subCb => {
            subCb.checked = false;
          });
        }
      });
    });
  }

  // Handle Staff Form Submission
  staffForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = staffForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    showMessage('Creating account…', 'success');

    try {
      const fd = new FormData(staffForm);
      await window.auth.signUpStaff({
        full_name: String(fd.get('full_name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
        notes: String(fd.get('notes') || '').trim()
      });
      staffForm.reset();
      showMessage('Staff application submitted. You can log in once a Super Admin approves your account.', 'success');
    } catch (error) {
      showMessage(error.message || 'Unable to submit staff application.');
    } finally {
      submitButton.disabled = false;
    }
  });

  // Handle Teacher Form Submission
  teacherForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = document.getElementById('teacher-submit-btn');
    submitButton.disabled = true;
    clearMessage();

    try {
      const fd = new FormData(teacherForm);
      const fullName = String(fd.get('full_name') || '').trim();
      const email = String(fd.get('email') || '').trim();
      const password = String(fd.get('password') || '');
      const phone = String(fd.get('phone') || '').trim();

      if (!fullName) throw new Error('Full name is required.');
      if (!email) throw new Error('Email address is required.');
      if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');

      // Collect selected classes and subjects
      const requestedClasses = [];
      const classCheckboxes = classesContainer.querySelectorAll('.class-select-checkbox:checked');

      if (classCheckboxes.length === 0) {
        throw new Error('Please select at least one class to teach.');
      }

      for (const cb of classCheckboxes) {
        const classId = parseInt(cb.dataset.classId, 10);
        const details = document.getElementById(`class-details-${classId}`);
        const isClassTeacher = Boolean(details.querySelector('.class-teacher-checkbox')?.checked);
        const subjectCbs = details.querySelectorAll(`input[name="subject_${classId}"]:checked`);
        const subjectIds = Array.from(subjectCbs).map(s => parseInt(s.value, 10)).filter(Boolean);

        if (subjectIds.length === 0 && !isClassTeacher) {
          const clsObj = academicClasses.find(c => c.id === classId);
          throw new Error(`Please select at least one subject for class "${clsObj?.name || classId}", or apply as Class Teacher.`);
        }

        requestedClasses.push({
          class_id: classId,
          is_class_teacher: isClassTeacher,
          subject_ids: subjectIds
        });
      }

      showMessage('Submitting application and creating secure account…', 'success');

      await window.auth.signUpTeacher({
        full_name: fullName,
        email: email,
        password: password,
        phone: phone,
        requested_classes: requestedClasses
      });

      teacherForm.reset();
      // collapse cards
      classesContainer.querySelectorAll('.class-details').forEach(el => el.style.display = 'none');
      classesContainer.querySelectorAll('.class-card').forEach(el => el.classList.remove('selected'));

      showMessage('Teacher application submitted successfully! Your account will be activated once approved by the Super Admin.', 'success');
    } catch (error) {
      showMessage(error.message || 'Unable to submit teacher application.');
    } finally {
      submitButton.disabled = false;
    }
  });
});
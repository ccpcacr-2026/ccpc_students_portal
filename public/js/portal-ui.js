/* ════════════════════════════════════════════════════════════════════
   CCPC Student Portal — UI Population & Data Binding
   Populates sidebar, tabs, and main content with student data
   ═════════════════════════════════════════════════════════════════════ */

let loggedInStudent = null;
let studentTabs = [];
let currentTabId = null;

// ── Initialize Portal ────────────────────────────────────────────────
async function initializePortal(studentData) {
  loggedInStudent = studentData;

  // Populate student card in sidebar
  populateSidebarStudentCard();

  // Fetch and populate tabs
  await loadStudentTabs();

  // Populate mobile header
  populateMobileHeader();

  // Show portal sections
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('form-section').style.classList.remove('hidden');
  document.getElementById('sidebar-container').classList.remove('hidden');
}

// ── Populate Sidebar Student Card ────────────────────────────────────
function populateSidebarStudentCard() {
  if (!loggedInStudent) return;

  const card = document.getElementById('sidebar-student-card');
  const avatar = document.getElementById('sidebar-student-avatar');
  const name = document.getElementById('sidebar-student-name');
  const id = document.getElementById('sidebar-student-id-label');

  if (!card) return;

  // Get initials from student name
  const initials = loggedInStudent.name
    .split(' ')
    .slice(0, 2)
    .map(n => n[0])
    .join('')
    .toUpperCase();

  avatar.textContent = initials;
  name.textContent = loggedInStudent.name;
  id.textContent = loggedInStudent.student_id;

  card.style.display = 'flex';
}

// ── Populate Mobile Header ───────────────────────────────────────────
function populateMobileHeader() {
  if (!loggedInStudent) return;

  const header = document.getElementById('mobile-header');
  if (!header) return;

  header.innerHTML = `
    <div class="institute-logo-container" style="width:40px;height:40px;border-radius:11px;flex-shrink:0">
      <img src="/logo.png" class="institute-logo-img" alt="Logo" style="width:100%;height:100%">
    </div>
    <div>
      <div style="font-size:0.78rem;font-weight:900;color:var(--primary);letter-spacing:0.01em;line-height:1.2">CCPC Portal</div>
      <div style="font-size:0.58rem;font-weight:700;color:var(--text-3);letter-spacing:0.05em;text-transform:uppercase">Student Portal</div>
    </div>
  `;
  header.classList.remove('hidden');
}

// ── Load Student Tabs from API ───────────────────────────────────────
async function loadStudentTabs() {
  try {
    const response = await fetch('/api/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get_tabs',
        student_id: loggedInStudent.student_id
      })
    });

    const result = await response.json();

    if (result.result === 'success') {
      studentTabs = result.data || [];
      populateSidebarTabs();
      populateBottomNav();

      // Load first tab by default
      if (studentTabs.length > 0) {
        selectTab(studentTabs[0].tab_id);
      }
    } else {
      console.error('Error loading tabs:', result.message);
    }
  } catch (error) {
    console.error('Error fetching tabs:', error);
  }
}

// ── Populate Sidebar Tabs ────────────────────────────────────────────
function populateSidebarTabs() {
  const sidebarItems = document.getElementById('sidebar-items');
  if (!sidebarItems) return;

  sidebarItems.innerHTML = studentTabs.map(tab => `
    <button class="nav-item-btn"
            data-tab-id="${tab.tab_id}"
            onclick="selectTab('${tab.tab_id}')">
      <i class="bi bi-${tab.icon || 'folder-fill'}"></i>
      <span>${tab.tab_name}</span>
      <div class="nav-fill-badge" style="margin-left:auto">
        ${getTabCompletionPercentage(tab.tab_id)}%
      </div>
    </button>
  `).join('');
}

// ── Populate Bottom Nav (Mobile) ─────────────────────────────────────
function populateBottomNav() {
  const bottomNav = document.getElementById('bottom-nav-container');
  if (!bottomNav) return;

  bottomNav.innerHTML = studentTabs.map(tab => `
    <button class="nav-item-btn"
            data-tab-id="${tab.tab_id}"
            onclick="selectTab('${tab.tab_id}')">
      <i class="bi bi-${tab.icon || 'folder-fill'}"></i>
      <span>${tab.tab_name}</span>
    </button>
  `).join('');
}

// ── Select Tab & Load Content ────────────────────────────────────────
async function selectTab(tabId) {
  currentTabId = tabId;

  // Update active states
  document.querySelectorAll('.nav-item-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabId === tabId);
  });

  // Load tab content
  await loadTabContent(tabId);
}

// ── Load Tab Content ─────────────────────────────────────────────────
async function loadTabContent(tabId) {
  try {
    const response = await fetch('/api/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get_student_tab_data',
        student_id: loggedInStudent.student_id,
        tab_id: tabId
      })
    });

    const result = await response.json();

    if (result.result === 'success') {
      renderTabForm(result.data);
    } else {
      showError(result.message || 'Error loading tab data');
    }
  } catch (error) {
    console.error('Error loading tab content:', error);
    showError('Failed to load tab content');
  }
}

// ── Get Tab Completion Percentage ────────────────────────────────────
function getTabCompletionPercentage(tabId) {
  // This would calculate based on form fields filled
  // For now, return 0
  return 0;
}

// ── Render Tab Form ──────────────────────────────────────────────────
function renderTabForm(tabData) {
  const wrapper = document.getElementById('portal-content-wrapper');
  if (!wrapper) return;

  // Get the tab metadata
  const tab = studentTabs.find(t => t.tab_id === currentTabId);
  if (!tab) return;

  // Create form HTML using FormRenderer
  let formHtml = `
    <div class="card">
      <h2 class="section-title">
        <i class="bi bi-${tab.icon || 'folder-fill'}"></i>
        ${tab.tab_name}
      </h2>
  `;

  if (tab.include_fields && tab.include_fields.length > 0) {
    formHtml += '<div class="include-master-info">';
    tab.include_fields.forEach(field => {
      const value = loggedInStudent[field] || '—';
      formHtml += `
        <div class="imi-label">${field.replace(/_/g, ' ').toUpperCase()}</div>
        <div class="imi-value">${value}</div>
      `;
    });
    formHtml += '</div>';
  }

  // Render form fields
  if (tab.fields_json && tab.fields_json.length > 0) {
    const fields = JSON.parse(typeof tab.fields_json === 'string' ? tab.fields_json : JSON.stringify(tab.fields_json));

    formHtml += '<div class="form-area">';
    fields.forEach(field => {
      formHtml += renderFormField(field);
    });
    formHtml += '</div>';
  }

  formHtml += `
    <div class="mt-4">
      <button class="btn btn-primary" onclick="submitTabForm('${currentTabId}')">
        <i class="bi bi-check-circle me-2"></i> Submit Form
      </button>
    </div>
    </div>
  `;

  wrapper.innerHTML = formHtml;
}

// ── Render Form Field ────────────────────────────────────────────────
function renderFormField(field) {
  const fieldId = `field-${field.id || field.name}`;
  let html = `<div class="mb-3">`;

  if (field.label) {
    html += `<label class="form-label" for="${fieldId}">${field.label}`;
    if (field.required) html += ' <span class="text-danger">*</span>';
    html += `</label>`;
  }

  switch (field.type) {
    case 'text':
    case 'email':
    case 'number':
      html += `<input type="${field.type}" id="${fieldId}" class="form-control"
               name="${field.name}" placeholder="${field.placeholder || ''}"
               ${field.required ? 'required' : ''}>`;
      break;

    case 'textarea':
      html += `<textarea id="${fieldId}" class="form-control"
               name="${field.name}" placeholder="${field.placeholder || ''}"
               rows="4" ${field.required ? 'required' : ''}></textarea>`;
      break;

    case 'select':
      html += `<select id="${fieldId}" class="form-control" name="${field.name}"
               ${field.required ? 'required' : ''}>
               <option value="">Select ${field.label || 'option'}</option>`;
      (field.options || []).forEach(opt => {
        html += `<option value="${opt}">${opt}</option>`;
      });
      html += `</select>`;
      break;

    case 'checkbox':
      html += `<div class="form-check">
               <input class="form-check-input" type="checkbox" id="${fieldId}"
                      name="${field.name}">
               <label class="form-check-label" for="${fieldId}">
                 ${field.label || 'Check this box'}
               </label>
             </div>`;
      break;

    case 'radio':
      html += `<div class="form-check">`;
      (field.options || []).forEach((opt, i) => {
        const optId = `${fieldId}-${i}`;
        html += `<div class="form-check">
                 <input class="form-check-input" type="radio" name="${field.name}"
                        id="${optId}" value="${opt}">
                 <label class="form-check-label" for="${optId}">${opt}</label>
               </div>`;
      });
      html += `</div>`;
      break;

    case 'date':
      html += `<input type="date" id="${fieldId}" class="form-control"
               name="${field.name}" ${field.required ? 'required' : ''}>`;
      break;
  }

  if (field.help_text) {
    html += `<small class="form-text text-muted">${field.help_text}</small>`;
  }

  html += `</div>`;
  return html;
}

// ── Submit Tab Form ──────────────────────────────────────────────────
async function submitTabForm(tabId) {
  const formData = new FormData();

  // Collect all form values
  const data = {};
  document.querySelectorAll('.form-area input, .form-area select, .form-area textarea').forEach(el => {
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value;
    } else {
      data[el.name] = el.value;
    }
  });

  try {
    const response = await fetch('/api/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit',
        student_id: loggedInStudent.student_id,
        tab_id: tabId,
        data: data
      })
    });

    const result = await response.json();

    if (result.result === 'success') {
      showSuccess('Form submitted successfully!');
      // Reload tab content to show updated state
      await loadTabContent(tabId);
    } else {
      showError(result.message || 'Error submitting form');
    }
  } catch (error) {
    console.error('Error submitting form:', error);
    showError('Failed to submit form');
  }
}

// ── Show Success Toast ───────────────────────────────────────────────
function showSuccess(message) {
  alert(message); // Replace with toast later
}

// ── Show Error Toast ─────────────────────────────────────────────────
function showError(message) {
  alert(message); // Replace with toast later
}

// ── Logout ───────────────────────────────────────────────────────────
function logout() {
  localStorage.removeItem('ccpc_student_id');
  window.location.reload();
}
